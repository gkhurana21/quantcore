#pragma once
#include <cmath>
#include <cstdint>
#include <random>

namespace quantcore {

/*
 * Standard normal variates by the ziggurat method: Doornik's ZIGNOR (2005), 128 layers. Each attempt
 * takes one 64-bit draw — 53 bits for the uniform and 7 separate bits for the layer (the original
 * Marsaglia–Tsang generator reused bits and fails correlation tests). About 99% of draws are accepted
 * in the rectangles with a single multiplication; the rest go through the wedge test or, in the base
 * layer, Marsaglia's exponential sampler for the tail beyond R = 3.4426.
 *
 * The layer tables are exact binary (hex-float) literals, generated once from the ZIGNOR recurrence
 * (R = 3.442619855899, layer area V = 9.91256303526217e-3), so the native and WebAssembly builds sample
 * from identical tables.
 */
namespace zig {
inline constexpr double kZigX[129] = {
    0x1.db4668fe7e4a4p+1, 0x1.b8a7c476d2be8p+1, 0x1.9c8e0c7c8098fp+1,
    0x1.8aa73e440ffbcp+1, 0x1.7d45eb36eb842p+1, 0x1.7279dd4ac3f9dp+1,
    0x1.695c2be68edc9p+1, 0x1.616dff7c8f54ap+1, 0x1.5a61edf7e8f32p+1,
    0x1.54052012a04a4p+1, 0x1.4e3456b0e3a1bp+1, 0x1.48d61806d6010p+1,
    0x1.43d75b60bca1dp+1, 0x1.3f29848d3b416p+1, 0x1.3ac11b8e206d6p+1,
    0x1.3694f3a3740d9p+1, 0x1.329d9725e32f7p+1, 0x1.2ed4df8099571p+1,
    0x1.2b35aa5ebee3ep+1, 0x1.27bba2b5dbc92p+1, 0x1.246317a6b53c0p+1,
    0x1.2128dd36bdf09p+1, 0x1.1e0a342cf08f6p+1, 0x1.1b04b731f6bccp+1,
    0x1.18164be0c1c39p+1, 0x1.153d16d45743dp+1, 0x1.12777201834f3p+1,
    0x1.0fc3e4d95f278p+1, 0x1.0d211dd28b00fp+1, 0x1.0a8ded0ec371ap+1,
    0x1.08093fe3e40e1p+1, 0x1.05921d1c4d769p+1, 0x1.0327a1cc4cf5ep+1,
    0x1.00c8fea1720d4p+1, 0x1.fceaeb2ca5f17p+0, 0x1.f858aff31cbf0p+0,
    0x1.f3da097460823p+0, 0x1.ef6dcddc7d392p+0, 0x1.eb12e91486bbcp+0,
    0x1.e6c85a849b015p+0, 0x1.e28d331c6723cp+0, 0x1.de609397e09b9p+0,
    0x1.da41aaf79a344p+0, 0x1.d62fb52580b86p+0, 0x1.d229f9bfeefdbp+0,
    0x1.ce2fcb05f8c34p+0, 0x1.ca4084e091e34p+0, 0x1.c65b8c04dbac2p+0,
    0x1.c2804d2c6b16fp+0, 0x1.beae3c60cd0e4p+0, 0x1.bae4d457ee119p+0,
    0x1.b72395df5b73bp+0, 0x1.b36a075498d64p+0, 0x1.afb7b428fe7a1p+0,
    0x1.ac0c2c6fc6382p+0, 0x1.a867047516e4fp+0, 0x1.a4c7d45d01a31p+0,
    0x1.a12e37c983369p+0, 0x1.9d99cd86b58b4p+0, 0x1.9a0a373c73f21p+0,
    0x1.967f1924c7b06p+0, 0x1.92f819c682bf5p+0, 0x1.8f74e1b37c6b8p+0,
    0x1.8bf51b49ef337p+0, 0x1.88787278810a6p+0, 0x1.84fe9484873b9p+0,
    0x1.81872fd21db73p+0, 0x1.7e11f3adaeb92p+0, 0x1.7a9e90168b8eep+0,
    0x1.772cb58a39dd6p+0, 0x1.73bc14d01a2c9p+0, 0x1.704c5ec50cb81p+0,
    0x1.6cdd4426b88a5p+0, 0x1.696e755e16b84p+0, 0x1.65ffa248e016dp+0,
    0x1.62907a0176ebfp+0, 0x1.5f20aaa4dfc1ap+0, 0x1.5bafe11654817p+0,
    0x1.583dc8bff3219p+0, 0x1.54ca0b4ffd349p+0, 0x1.515450720f455p+0,
    0x1.4ddc3d83a5b84p+0, 0x1.4a617543306ccp+0, 0x1.46e39778de063p+0,
    0x1.436240982ad9dp+0, 0x1.3fdd09591d2a4p+0, 0x1.3c538647ef792p+0,
    0x1.38c54749b9033p+0, 0x1.3531d7146a43ep+0, 0x1.3198ba982d911p+0,
    0x1.2df97057e7efbp+0, 0x1.2a536fae30e33p+0, 0x1.26a627fb9d120p+0,
    0x1.22f0ffbaa1e55p+0, 0x1.1f335374a10f8p+0, 0x1.1b6c7492c9735p+0,
    0x1.179ba80463fecp+0, 0x1.13c024b2c7ec6p+0, 0x1.0fd911b97f236p+0,
    0x1.0be58456ff4aep+0, 0x1.07e47d87a40f6p+0, 0x1.03d4e7391c5b7p+0,
    0x1.ff6b21fffe31ap-1, 0x1.f70a5866c8f46p-1, 0x1.ee848e956826fp-1,
    0x1.e5d6909f51b6ap-1, 0x1.dcfccc51c59f0p-1, 0x1.d3f340dda611cp-1,
    0x1.cab56ac6a38d3p-1, 0x1.c13e2b014e85cp-1, 0x1.b787a7c516f3bp-1,
    0x1.ad8b2506a137cp-1, 0x1.a340d1baf5b18p-1, 0x1.989f85c753b2cp-1,
    0x1.8d9c6a9d35e3dp-1, 0x1.822a858af0e7dp-1, 0x1.763a1600eec74p-1,
    0x1.69b7b213f3f69p-1, 0x1.5c8afdbf0217bp-1, 0x1.4e94c08c0bab7p-1,
    0x1.3fabee1911cd7p-1, 0x1.2f98d6bb4f41fp-1, 0x1.1e0ce6b5969b3p-1,
    0x1.0a936da5e55adp-1, 0x1.e8e576e43fbefp-2, 0x1.b4c8fece48e83p-2,
    0x1.73949184db9dfp-2, 0x1.16db47e193e1ap-2, 0x0.0p+0,
};
inline constexpr double kZigR[128] = {
    0x1.dab48848d3c16p-1, 0x1.df5993967d2a6p-1, 0x1.e9c885d9a666bp-1,
    0x1.eea42f70ceeacp-1, 0x1.f1803c6a0781bp-1, 0x1.f366d2afaee48p-1,
    0x1.f4c3825de9f38p-1, 0x1.f5ca83ef26e1fp-1, 0x1.f69868793c530p-1,
    0x1.f73e31c89895dp-1, 0x1.f7c6a977e305fp-1, 0x1.f838ffd4ec0eap-1,
    0x1.f89a30bcaa7bbp-1, 0x1.f8edcde8cde13p-1, 0x1.f93677b627e76p-1,
    0x1.f97628687c107p-1, 0x1.f9ae64ccb1f64p-1, 0x1.f9e05ca2efdc3p-1,
    0x1.fa0d00cfbb6cdp-1, 0x1.fa3512e9cb952p-1, 0x1.fa59305b35722p-1,
    0x1.fa79da7e004a6p-1, 0x1.fa977c9ec13d6p-1, 0x1.fab27081a26dcp-1,
    0x1.facb01d4366f8p-1, 0x1.fae170d5cadc4p-1, 0x1.faf5f46a24900p-1,
    0x1.fb08bbbbc73bcp-1, 0x1.fb19ef88b6409p-1, 0x1.fb29b32d77103p-1,
    0x1.fb38257d095ffp-1, 0x1.fb456170e2019p-1, 0x1.fb517eb94bd58p-1,
    0x1.fb5c92349c858p-1, 0x1.fb66ae52354dbp-1, 0x1.fb6fe3652f8b4p-1,
    0x1.fb783fe9c00d0p-1, 0x1.fb7fd0bfb9735p-1, 0x1.fb86a15c1886fp-1,
    0x1.fb8cbbf324034p-1, 0x1.fb92299c5d1e0p-1, 0x1.fb96f271420e9p-1,
    0x1.fb9b1da7b43fcp-1, 0x1.fb9eb1a8ade0cp-1, 0x1.fba1b423d4107p-1,
    0x1.fba42a205a48cp-1, 0x1.fba6180b97b60p-1, 0x1.fba781c59edc5p-1,
    0x1.fba86aac1a8c1p-1, 0x1.fba8d5a3a81cbp-1, 0x1.fba8c51fddb9dp-1,
    0x1.fba83b2a23e8ep-1, 0x1.fba7396782fc8p-1, 0x1.fba5c11d7fba4p-1,
    0x1.fba3d3361dd1bp-1, 0x1.fba170431ac58p-1, 0x1.fb9e9880706abp-1,
    0x1.fb9b4bd62b198p-1, 0x1.fb9789d99cec9p-1, 0x1.fb9351cdf4f98p-1,
    0x1.fb8ea2a43f27ap-1, 0x1.fb897afacf29cp-1, 0x1.fb83d91c1719ap-1,
    0x1.fb7dbafce8335p-1, 0x1.fb771e3a1a365p-1, 0x1.fb70001593e79p-1,
    0x1.fb685d72ad163p-1, 0x1.fb6032d1e0430p-1, 0x1.fb577c4bbfa39p-1,
    0x1.fb4e358b1e8d0p-1, 0x1.fb4459c65d655p-1, 0x1.fb39e3b7c2e55p-1,
    0x1.fb2ecd94c9ba2p-1, 0x1.fb23110445454p-1, 0x1.fb16a7133b4f5p-1,
    0x1.fb0988284ac3dp-1, 0x1.fafbabf570e44p-1, 0x1.faed0967f6925p-1,
    0x1.fadd96964622ep-1, 0x1.facd48ab5f4e1p-1, 0x1.fabc13cf91f8fp-1,
    0x1.faa9eb0e19351p-1, 0x1.fa96c0371d81cp-1, 0x1.fa8283bd8f44dp-1,
    0x1.fa6d24902fe33p-1, 0x1.fa568fecff9b9p-1, 0x1.fa3eb12e1f177p-1,
    0x1.fa25718f03b34p-1, 0x1.fa0ab7e8a2982p-1, 0x1.f9ee6862ee1b5p-1,
    0x1.f9d06419a6a63p-1, 0x1.f9b088b20ff67p-1, 0x1.f98eafde8e73bp-1,
    0x1.f96aaecc7e5e7p-1, 0x1.f9445577b49f4p-1, 0x1.f91b6dddf8427p-1,
    0x1.f8efbb0b5013fp-1, 0x1.f8c0f7f61e36fp-1, 0x1.f88ed61f8e779p-1,
    0x1.f858fbe99f8adp-1, 0x1.f81f028fc2ae1p-1, 0x1.f7e073a948fe3p-1,
    0x1.f79cc61506b24p-1, 0x1.f7535a22e3d3fp-1, 0x1.f70374c1451abp-1,
    0x1.f6ac395f78bd5p-1, 0x1.f64ca218dbb22p-1, 0x1.f5e37591f6ccfp-1,
    0x1.f56f39b2b0507p-1, 0x1.f4ee220c30440p-1, 0x1.f45df82cd25b9p-1,
    0x1.f3bbfb4b67d62p-1, 0x1.f304b35b5d591p-1, 0x1.f233b16d764dap-1,
    0x1.f143339d7d788p-1, 0x1.f02b9c88c7353p-1, 0x1.eee2a3186b515p-1,
    0x1.ed5a0a98bc7cdp-1, 0x1.eb7d8a7ccd9edp-1, 0x1.e92f39746c228p-1,
    0x1.e641170f50cafp-1, 0x1.e26896f5fbf47p-1, 0x1.dd2487adcb4e3p-1,
    0x1.d58014742e544p-1, 0x1.c96d1a883d306p-1, 0x1.b3911e9b8053ep-1,
    0x1.803c6d4f93b49p-1, 0x0.0p+0,
};
}  // namespace zig

/** A standard normal variate from rng. */
inline double normal_ziggurat(std::mt19937_64& rng) {
    constexpr double kUnit = 0x1.0p-53;
    for (;;) {
        const std::uint64_t bits = rng();
        const unsigned i = static_cast<unsigned>(bits & 0x7F);
        const double u = 2.0 * (static_cast<double>(bits >> 11) * kUnit) - 1.0;
        if (std::fabs(u) < zig::kZigR[i]) return u * zig::kZigX[i];
        if (i == 0) {
            // base layer outside its rectangle: the tail beyond R
            const double R = zig::kZigX[1];
            double x, y;
            do {
                x = std::log((static_cast<double>(rng() >> 11) + 0.5) * kUnit) / R;
                y = std::log((static_cast<double>(rng() >> 11) + 0.5) * kUnit);
            } while (-2.0 * y < x * x);
            return u < 0.0 ? x - R : R - x;
        }
        const double x = u * zig::kZigX[i];
        const double f0 = std::exp(-0.5 * (zig::kZigX[i] * zig::kZigX[i] - x * x));
        const double f1 = std::exp(-0.5 * (zig::kZigX[i + 1] * zig::kZigX[i + 1] - x * x));
        if (f1 + (static_cast<double>(rng() >> 11) * kUnit) * (f0 - f1) < 1.0) return x;
    }
}

}  // namespace quantcore
