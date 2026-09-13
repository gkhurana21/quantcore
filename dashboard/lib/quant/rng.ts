// Seeded pseudo-random numbers. Every simulation in the terminal is seeded, so a
// given seed always reproduces the same prices, paths and histograms.

/** mulberry32: small, fast 32-bit generator; returns uniforms in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sampler via Box-Muller, consuming both variates of each pair. */
export function normalSampler(seed: number): () => number {
  const uniform = mulberry32(seed);
  let spare = 0;
  let hasSpare = false;
  return () => {
    if (hasSpare) { hasSpare = false; return spare; }
    const u1 = 1 - uniform();            // (0, 1] — never log(0)
    const u2 = uniform();
    const m = Math.sqrt(-2 * Math.log(u1));
    spare = m * Math.sin(2 * Math.PI * u2);
    hasSpare = true;
    return m * Math.cos(2 * Math.PI * u2);
  };
}
