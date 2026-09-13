// Standard normal distribution helpers.

const INV_SQRT_2PI = 0.3989422804014327;

export function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/**
 * Standard normal CDF in double precision: Hart's (1966) rational approximation
 * as given by West (2005), "Better approximations to cumulative normal
 * functions". The tail probability is evaluated on |x| and reflected. This
 * replaces Abramowitz & Stegun 26.2.17 (error up to 7.5e-8) so browser prices
 * track the C++ core's erfc-based N(x).
 */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let tail: number;
  if (z > 37) {
    tail = 0;
  } else {
    const e = Math.exp(-0.5 * z * z);
    if (z < 7.07106781186547) {
      let n = 3.52624965998911e-2 * z + 0.700383064443688;
      n = n * z + 6.37396220353165;
      n = n * z + 33.912866078383;
      n = n * z + 112.079291497871;
      n = n * z + 221.213596169931;
      n = n * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      tail = (e * n) / d;
    } else {
      let d = z + 0.65;
      d = z + 4 / d;
      d = z + 3 / d;
      d = z + 2 / d;
      d = z + 1 / d;
      tail = e / d / 2.506628274631;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

/** Inverse standard normal CDF (Acklam's rational approximation, rel. error ~1e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687,
             138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866,
             66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996,
             3.754408661907416];
  const tailP = 0.02425;
  if (p < tailP) {
    const u = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
           ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
  }
  if (p <= 1 - tailP) {
    const u = p - 0.5, r = u * u;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * u /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const u = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * u + c[1]) * u + c[2]) * u + c[3]) * u + c[4]) * u + c[5]) /
          ((((d[0] * u + d[1]) * u + d[2]) * u + d[3]) * u + 1);
}
