/*
 * monte_carlo_gpu.mm
 * ------------------
 * Apple Metal GPU Monte Carlo implementation.
 * Compiled as Objective-C++ (.mm) so it can call the Metal framework via
 * Objective-C message syntax — no external metal-cpp header required.
 *
 * The Metal compute kernel is embedded as a raw string literal and compiled
 * at runtime via [MTLDevice newLibraryWithSource:options:error:].  The Metal
 * JIT caches the compiled AIR on disk, so subsequent launches are fast.
 */

#include "quantcore/monte_carlo_gpu.hpp"

#include <cmath>
#include <stdexcept>
#include <string>

#import <Metal/Metal.h>
#import <Foundation/Foundation.h>

namespace quantcore {

// ── Metal compute kernel ──────────────────────────────────────────────────────
//
// Philox 4x32-10 reference: Salmon et al. 2011, SC'11.
// Counter = (gid, 0, 0, 0) — one unique counter per GPU thread.
// Key     = (seed, 0xDEADBEEF) — fixed for a given call.
//
// Statistical independence guarantee:
//   Philox is a keyed bijection on the counter space.  Thread i and thread j
//   (i ≠ j) use different counters, so their output sequences are non-overlapping
//   subsequences of a single long period PRNG.  This is the standard counter-based
//   approach used in Random123 and cuRAND's Philox backend.

static const char* kMetalSrc = R"msl(
#include <metal_stdlib>
using namespace metal;

// ── Philox 4x32-10 ────────────────────────────────────────────────────────────
static uint2 _ph_mulhilo(uint a, uint b) {
    ulong r = (ulong)a * (ulong)b;
    return uint2(uint(r >> 32), uint(r));   // (hi, lo)
}

static uint4 philox4x32_10(uint4 ctr, uint2 key) {
    // multipliers and Weyl constants from the Salmon et al. paper / Random123
    const uint M0 = 0xD2511F53u;
    const uint M1 = 0xCD9E8D57u;
    const uint W0 = 0x9E3779B9u;  // golden-ratio Weyl, 32-bit
    const uint W1 = 0xBB67AE85u;  // sqrt(3) Weyl, 32-bit

    uint4 x = ctr;
    uint2 k = key;
    for (int round = 0; round < 10; ++round) {
        uint2 h0 = _ph_mulhilo(M0, x[0]);  // (hi0, lo0)
        uint2 h1 = _ph_mulhilo(M1, x[2]);  // (hi1, lo1)
        // Round bijection (matches Random123 reference):
        //   new[0] = hi1 ^ x[1] ^ k[0]
        //   new[1] = lo1
        //   new[2] = hi0 ^ x[3] ^ k[1]
        //   new[3] = lo0
        x = uint4(h1[0] ^ x[1] ^ k[0],
                  h1[1],
                  h0[0] ^ x[3] ^ k[1],
                  h0[1]);
        k += uint2(W0, W1);
    }
    return x;
}

// uint32 → float in [0, 1)
static float u32_to_f01(uint u) {
    return float(u >> 8) * 0x1.0p-24f;   // / 2^24
}

// Box-Muller: 2 uniforms → 2 independent N(0,1)
static float2 box_muller(float u1, float u2) {
    float r = sqrt(-2.0f * log(max(u1, 1.0e-30f)));
    float t = 2.0f * M_PI_F * u2;
    return float2(r * cos(t), r * sin(t));
}

// ── parameter struct (must match CPP-side GPUParams layout exactly) ──────────
struct MCParams {
    float S, K, r, sigma, T;   // 5×4 = 20 bytes
    uint  is_call;              //     = 24
    uint  seed;                 //     = 28
    uint  n_paths;              //     = 32
};

// ── compute kernel ────────────────────────────────────────────────────────────
kernel void mc_gbm(
    device  const MCParams& p     [[ buffer(0) ]],
    device        float*    sums  [[ buffer(1) ]],   // partial sums
    device        float*    sums2 [[ buffer(2) ]],   // partial sums of squares
    uint gid [[ thread_position_in_grid        ]],
    uint lid [[ thread_position_in_threadgroup ]],
    uint tgs [[ threads_per_threadgroup        ]],
    threadgroup float* lsum  [[ threadgroup(0) ]],
    threadgroup float* lsum2 [[ threadgroup(1) ]])
{
    // ── 1. compute discounted payoff for this path ────────────────────────────
    float pv = 0.0f;
    if (gid < p.n_paths) {
        // Counter = (gid, 0, 0, 0)  |  Key = (seed, 0xDEADBEEF)
        // Each thread has a unique counter → independent PRNG stream.
        uint4 rnd = philox4x32_10(uint4(gid, 0u, 0u, 0u),
                                   uint2(p.seed, 0xDEADBEEFu));

        float2 n01 = box_muller(u32_to_f01(rnd[0]), u32_to_f01(rnd[1]));
        float  Z   = n01[0];

        float drift  = (p.r - 0.5f * p.sigma * p.sigma) * p.T;
        float volSqT = p.sigma * sqrt(p.T);
        float ST     = p.S * exp(drift + volSqT * Z);

        float payoff = p.is_call ? max(ST - p.K, 0.0f)
                                  : max(p.K - ST, 0.0f);
        pv = exp(-p.r * p.T) * payoff;
    }

    // ── 2. threadgroup (local) reduction ─────────────────────────────────────
    lsum [lid] = pv;
    lsum2[lid] = pv * pv;

    threadgroup_barrier(mem_flags::mem_threadgroup);

    for (uint stride = tgs >> 1; stride > 0; stride >>= 1) {
        if (lid < stride) {
            lsum [lid] += lsum [lid + stride];
            lsum2[lid] += lsum2[lid + stride];
        }
        threadgroup_barrier(mem_flags::mem_threadgroup);
    }

    // Thread 0 of each group writes the group's partial sum.
    // gid for thread 0 of group g is g*tgs, so group index = gid/tgs.
    if (lid == 0) {
        uint g        = gid / tgs;
        sums [g]  = lsum [0];
        sums2[g]  = lsum2[0];
    }
}
)msl";


// ── Metal state (lazily initialised, thread-safe via dispatch_once) ───────────

static id<MTLDevice>               g_device = nil;
static id<MTLCommandQueue>         g_queue  = nil;
static id<MTLComputePipelineState> g_pso    = nil;
static NSString*                   g_name   = nil;

static void metal_init_impl() {
    @autoreleasepool {
        g_device = MTLCreateSystemDefaultDevice();
        if (!g_device)
            throw std::runtime_error("mc_price_gpu: no Metal device found");

        g_name = g_device.name;

        NSError*   err = nil;
        NSString*  src = [NSString stringWithUTF8String:kMetalSrc];
        id<MTLLibrary> lib = [g_device newLibraryWithSource:src
                                                    options:nil
                                                      error:&err];
        if (!lib)
            throw std::runtime_error(
                std::string("mc_price_gpu: Metal shader compile failed: ") +
                [[err localizedDescription] UTF8String]);

        id<MTLFunction> fn = [lib newFunctionWithName:@"mc_gbm"];
        if (!fn)
            throw std::runtime_error("mc_price_gpu: kernel 'mc_gbm' not found");

        g_pso = [g_device newComputePipelineStateWithFunction:fn error:&err];
        if (!g_pso)
            throw std::runtime_error(
                std::string("mc_price_gpu: PSO creation failed: ") +
                [[err localizedDescription] UTF8String]);

        g_queue = [g_device newCommandQueue];
    }
}

static void ensure_metal() {
    static dispatch_once_t token;
    dispatch_once(&token, ^{ metal_init_impl(); });
}


// ── parameter struct (must match MSL layout) ─────────────────────────────────
struct GPUParams {
    float    S, K, r, sigma, T;  // 5 × 4 = 20 bytes
    uint32_t is_call;             // 4 bytes → 24
    uint32_t seed;                // 4 bytes → 28
    uint32_t n_paths;             // 4 bytes → 32
};
static_assert(sizeof(GPUParams) == 32, "GPUParams size mismatch");


// ── public functions ──────────────────────────────────────────────────────────

std::string mc_gpu_device_name() {
    ensure_metal();
    return [g_name UTF8String];
}

MCResult mc_price_gpu(OptionType type, double S, double K, double r,
                       double sigma, double T, long long paths, uint64_t seed) {
    ensure_metal();

    @autoreleasepool {
        const uint32_t N   = static_cast<uint32_t>(paths);
        const uint32_t TGS = 256;                        // threads per threadgroup
        const uint32_t NG  = (N + TGS - 1u) / TGS;     // number of groups

        // ── buffers ──────────────────────────────────────────────────────────
        GPUParams p;
        p.S       = float(S);
        p.K       = float(K);
        p.r       = float(r);
        p.sigma   = float(sigma);
        p.T       = float(T);
        p.is_call = (type == OptionType::Call) ? 1u : 0u;
        p.seed    = uint32_t(seed & 0xFFFFFFFFu);
        p.n_paths = N;

        id<MTLBuffer> pb  = [g_device newBufferWithBytes:&p
                                                  length:sizeof(p)
                                                 options:MTLResourceStorageModeShared];
        id<MTLBuffer> sb  = [g_device newBufferWithLength:NG * sizeof(float)
                                                  options:MTLResourceStorageModeShared];
        id<MTLBuffer> s2b = [g_device newBufferWithLength:NG * sizeof(float)
                                                  options:MTLResourceStorageModeShared];

        // ── encode ───────────────────────────────────────────────────────────
        id<MTLCommandBuffer>         cmd = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cmd computeCommandEncoder];

        [enc setComputePipelineState:g_pso];
        [enc setBuffer:pb  offset:0 atIndex:0];
        [enc setBuffer:sb  offset:0 atIndex:1];
        [enc setBuffer:s2b offset:0 atIndex:2];
        // Two separate threadgroup memory regions (index 0 and 1)
        [enc setThreadgroupMemoryLength:TGS * sizeof(float) atIndex:0];
        [enc setThreadgroupMemoryLength:TGS * sizeof(float) atIndex:1];

        // dispatchThreadgroups: exact NG groups; boundary handled by gid < n_paths
        MTLSize numGroups = MTLSizeMake(NG, 1, 1);
        MTLSize groupSize = MTLSizeMake(TGS, 1, 1);
        [enc dispatchThreadgroups:numGroups threadsPerThreadgroup:groupSize];
        [enc endEncoding];

        [cmd commit];
        [cmd waitUntilCompleted];

        if (cmd.status == MTLCommandBufferStatusError)
            throw std::runtime_error(
                std::string("mc_price_gpu: GPU kernel error: ") +
                [[cmd.error localizedDescription] UTF8String]);

        // ── host reduction (double precision to avoid float32 accumulation) ──
        float* sums  = static_cast<float*>([sb  contents]);
        float* sums2 = static_cast<float*>([s2b contents]);

        double sum = 0.0, sum_sq = 0.0;
        for (uint32_t i = 0; i < NG; ++i) {
            sum    += double(sums [i]);
            sum_sq += double(sums2[i]);
        }

        double mean     = sum / double(N);
        double variance = (sum_sq / double(N) - mean * mean) / double(N);
        double std_err  = std::sqrt(std::max(variance, 0.0));

        return MCResult{mean, std_err, paths};
    }
}

} // namespace quantcore
