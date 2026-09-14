/**
 * Property-based tests: hundreds of seeded random markets, portfolios and files
 * checked against invariants that must hold for every input — bounds, parity,
 * finite differences, dense payoff scans, round trips and never-throw parsing.
 * Seeds are fixed, so any failure reproduces exactly.
 */

import { test, expect } from '@playwright/test';
import { mulberry32 } from '../lib/quant/rng';
import { bsGreeks, bsPrice, intrinsic } from '../lib/quant/blackScholes';
import { crrAmericanPrice, crrPrice } from '../lib/quant/binomial';
import { impliedVol } from '../lib/quant/impliedVol';
import { mcPortfolio } from '../lib/quant/monteCarlo';
import { normCdf, normInv } from '../lib/quant/normal';
import type { Leg, Market, Smile, TermStructure } from '../lib/quant/types';
import { atSpot, fittedTerm, legSigma } from '../lib/quant/volSurface';
import { CONTRACT_MULT as M, signedQty } from '../lib/quant/types';
import { payoffAnalytics, pnlAtFirstExpiry, portfolioGreeks, portfolioValue } from '../lib/strategy/portfolio';
import { NO_SHOCK, SCENARIOS, stressReport } from '../lib/risk/stress';
import { deltaNormalVaR, mcVaR } from '../lib/risk/var';
import { pnlSurface } from '../lib/risk/surface';
import { importPortfolio, parseCsvText } from '../lib/io/portfolioParser';
import { fixed, num, pct, signed, usd, usdCompact, usdSigned } from '../lib/format';
import { niceTicks, strikeTick } from '../components/charts/scale';

function rng(seed: number) {
  const u = mulberry32(seed);
  return {
    u,
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(u() * xs.length)],
    range: (a: number, b: number) => a + (b - a) * u(),
    logRange: (a: number, b: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u()),
    int: (a: number, b: number) => a + Math.floor(u() * (b - a + 1)),
  };
}
type Rng = ReturnType<typeof rng>;

const randomMarket = (g: Rng): Market =>
  ({ S: g.logRange(5, 3000), sigma: g.logRange(0.02, 1.5), r: g.range(0, 0.12), q: g.range(0, 0.08) });

/** Random portfolio; 20% of legs are entered at zero premium (zero-cost structures, free legs). */
function randomLegs(g: Rng, m: Market, sameExpiry: boolean, minT = 1 / 365): Leg[] {
  const n = g.int(1, 8);
  const T0 = g.logRange(minT, 3);
  return Array.from({ length: n }, (_, i) => {
    const call = g.u() < 0.5;
    const K = +(m.S * g.logRange(0.5, 1.6)).toFixed(2);
    const T = sameExpiry ? T0 : g.logRange(minT, 3);
    const premium = g.u() < 0.2 ? 0 : bsPrice(call, m.S, K, T, m.sigma, m.r, m.q) * g.range(0.5, 1.5);
    return { id: `p${i}`, call, side: g.u() < 0.5 ? 'buy' : 'sell', qty: g.int(1, 20), K, T, premium } as Leg;
  });
}

/** A random SSVI smile inside the arbitrage-free region. */
function randomSmile(g: Rng): Smile {
  const rho = g.range(-0.95, 0.95);
  return { rho, eta: g.range(0.05, 2 / (1 + Math.abs(rho))), gamma: g.range(0.05, 0.5) };
}

const finite = (o: Record<string, number>) => Object.values(o).every(Number.isFinite);

test.describe('property: pricing', () => {
  test('Black-Scholes-Merton is finite, within no-arbitrage bounds and satisfies parity at extreme inputs', () => {
    const g = rng(1);
    for (let i = 0; i < 2000; i++) {
      const m = randomMarket(g);
      const K = m.S * g.logRange(0.2, 5), T = g.logRange(1e-4, 10), sigma = g.logRange(1e-3, 3);
      const c = bsGreeks(true, m.S, K, T, sigma, m.r, m.q), p = bsGreeks(false, m.S, K, T, sigma, m.r, m.q);
      const ctx = JSON.stringify({ ...m, K, T, sigma });
      expect(finite({ ...c }) && finite({ ...p }), ctx).toBe(true);
      const dq = Math.exp(-m.q * T), dr = Math.exp(-m.r * T), tol = 1e-9 * Math.max(m.S, K);
      expect(c.price, ctx).toBeGreaterThanOrEqual(Math.max(m.S * dq - K * dr, 0) - tol);
      expect(c.price, ctx).toBeLessThanOrEqual(m.S * dq + tol);
      expect(p.price, ctx).toBeGreaterThanOrEqual(Math.max(K * dr - m.S * dq, 0) - tol);
      expect(p.price, ctx).toBeLessThanOrEqual(K * dr + tol);
      expect(Math.abs(c.price - p.price - (m.S * dq - K * dr)), ctx).toBeLessThan(tol);
      expect(c.delta, ctx).toBeGreaterThanOrEqual(-1e-12);
      expect(c.delta, ctx).toBeLessThanOrEqual(dq + 1e-12);
      expect(p.delta, ctx).toBeLessThanOrEqual(1e-12);
      expect(p.delta, ctx).toBeGreaterThanOrEqual(-dq - 1e-12);
      expect(c.gamma, ctx).toBeGreaterThanOrEqual(0);
      expect(c.vega, ctx).toBeGreaterThanOrEqual(0);
    }
  });

  test('normal CDF is bounded and monotone; the inverse round-trips', () => {
    const g = rng(2);
    const xs = Array.from({ length: 5000 }, () => g.range(-40, 40)).sort((a, b) => a - b);
    for (let i = 0; i < xs.length; i++) {
      const v = normCdf(xs[i]);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (i) expect(v).toBeGreaterThanOrEqual(normCdf(xs[i - 1]));
      if (Math.abs(xs[i]) < 5) expect(Math.abs(normInv(v) - xs[i])).toBeLessThan(1e-7);
    }
  });

  test('portfolio Greeks match finite differences of portfolio value', () => {
    const g = rng(3);
    for (let i = 0; i < 300; i++) {
      const m = randomMarket(g);
      const legs = randomLegs(g, m, false, 7 / 365);
      const gk = portfolioGreeks(legs, m);
      const size = legs.reduce((a, l) => a + l.qty * M, 0);
      const V = (S = m.S, sigma = m.sigma, dT = 0) =>
        portfolioValue(legs.map(l => ({ ...l, T: l.T + dT })), { ...m, S, sigma });
      // Spot bumps are scaled to the width of the nearest expiry's price distribution
      // (one standard deviation, S·σ·√T): at low vol and short maturity gamma is a narrow
      // spike, and a bump proportional to S alone would not resolve it.
      const width = m.S * m.sigma * Math.sqrt(Math.min(...legs.map(l => l.T)));
      const hS = 1e-3 * width, hG = 2e-2 * width, hV = 1e-5, hT = 1e-6;
      const ctx = JSON.stringify({ m, legs });
      expect(Math.abs(gk.delta - (V(m.S + hS) - V(m.S - hS)) / (2 * hS)), ctx).toBeLessThan(1e-5 * size);
      expect(Math.abs(gk.vega - (V(m.S, m.sigma + hV) - V(m.S, m.sigma - hV)) / (2 * hV)), ctx).toBeLessThan(1e-4 * size * m.S);
      expect(Math.abs(gk.theta + (V(m.S, m.sigma, hT) - V(m.S, m.sigma, -hT)) / (2 * hT)), ctx).toBeLessThan(1e-3 * size * m.S);
      // Gamma reference: Richardson-extrapolated second difference, (4·D(h/2) − D(h))/3, error O(h⁴).
      // The plain O(h²) difference errs in proportion to each leg's own gamma, so a short
      // near-the-money leg netted against a long one leaves a reference error larger than the
      // tolerance on the small net gamma.
      const D2 = (h: number) => (V(m.S + h) - 2 * V() + V(m.S - h)) / (h * h);
      expect(Math.abs(gk.gamma - (4 * D2(hG / 2) - D2(hG)) / 3), ctx)
        .toBeLessThan(1e-4 * Math.abs(gk.gamma) + 1e-6 * size / m.S);
    }
  });

  test('CRR lattice: close to Black-Scholes; American ≥ European ≥ 0 and American ≥ intrinsic', () => {
    const g = rng(4);
    for (let i = 0; i < 150; i++) {
      const m = randomMarket(g);
      const call = g.u() < 0.5, K = m.S * g.logRange(0.6, 1.5), T = g.logRange(7 / 365, 3);
      const bs = bsPrice(call, m.S, K, T, m.sigma, m.r, m.q);
      const eu = crrPrice(call, m.S, K, T, m.sigma, m.r, m.q, 512);
      const am = crrAmericanPrice(call, m.S, K, T, m.sigma, m.r, m.q, 512);
      const ctx = JSON.stringify({ ...m, call, K, T });
      expect(Math.abs(eu - bs), ctx).toBeLessThan(0.002 * m.S * m.sigma * Math.sqrt(T) + 1e-9);
      expect(eu, ctx).toBeGreaterThanOrEqual(-1e-12);
      expect(am, ctx).toBeGreaterThanOrEqual(eu - 1e-9 * m.S);
      expect(am, ctx).toBeGreaterThanOrEqual(intrinsic(call, m.S, K) - 1e-9 * m.S);
    }
  });

  test('implied volatility reproduces the price for every solvable option', () => {
    const g = rng(5);
    let solved = 0;
    for (let i = 0; i < 1500; i++) {
      const m = randomMarket(g);
      const call = g.u() < 0.5, K = m.S * g.logRange(0.5, 2), T = g.logRange(2 / 365, 5), sigma = g.logRange(0.01, 3);
      const gk = bsGreeks(call, m.S, K, T, sigma, m.r, m.q);
      const iv = impliedVol(call, gk.price, m.S, K, T, m.r, m.q);
      const ctx = JSON.stringify({ ...m, call, K, T, sigma, price: gk.price });
      if (gk.vega / m.S > 1e-3) {
        expect(iv, ctx).not.toBeNull();
        expect(Math.abs(iv!.sigma - sigma) / sigma, ctx).toBeLessThan(1e-6);
        solved++;
      }
      if (iv) expect(Math.abs(bsPrice(call, m.S, K, T, iv.sigma, m.r, m.q) - gk.price), ctx).toBeLessThan(1e-8 * m.S);
    }
    expect(solved).toBeGreaterThan(500);
  });

  test('portfolio Monte Carlo agrees with the closed form within 4 standard errors', () => {
    const g = rng(6);
    for (let i = 0; i < 40; i++) {
      const m = randomMarket(g);
      const legs = randomLegs(g, m, false);
      const ref = portfolioValue(legs, m);
      const mc = mcPortfolio(legs, m, 20_000, 100 + i);
      const size = legs.reduce((a, l) => a + l.qty * M, 0);
      expect(Math.abs(mc.price - ref), JSON.stringify({ m, legs, mc: mc.price, se: mc.se, ref }))
        .toBeLessThan(4 * mc.se + 1e-3 * size);
    }
  });
});

test.describe('property: strategy and risk', () => {
  test('single-expiry payoff analytics agree with a dense scan of the expiry payoff', () => {
    const g = rng(7);
    for (let i = 0; i < 400; i++) {
      const m = randomMarket(g);
      const legs = randomLegs(g, m, true);
      const a = payoffAnalytics(legs, m);
      const f = (x: number) => legs.reduce((s, l) => s + signedQty(l) * M * (intrinsic(l.call, x, l.K) - l.premium), 0);
      const maxK = Math.max(m.S, ...legs.map(l => l.K));
      const scale = legs.reduce((s, l) => s + l.qty * M * (maxK + l.premium), 0);
      const tol = 1e-9 * scale;
      const xs: number[] = [];
      for (let k = 0; k <= 20_000; k++) xs.push((5 * maxK * k) / 20_000);
      xs.push(...legs.map(l => l.K));
      xs.sort((p, q) => p - q);
      const vs = xs.map(f);
      const ctx = JSON.stringify({ legs, a });

      if (a.maxProfitUnbounded) expect(f(20 * maxK), ctx).toBeGreaterThan(f(10 * maxK));
      else expect(Math.abs(a.maxProfit - Math.max(...vs)), ctx).toBeLessThan(tol + 1e-9);
      if (a.maxLossUnbounded) expect(f(20 * maxK), ctx).toBeLessThan(f(10 * maxK));
      else expect(Math.abs(a.maxLoss - Math.min(...vs)), ctx).toBeLessThan(tol + 1e-9);

      for (const b of a.breakevens) expect(Math.abs(f(b)), `${ctx} B/E ${b}`).toBeLessThan(tol + 1e-9);

      // every move between a loss region and a profit region must report a break-even in between
      let last: { x: number; s: number } | null = null;
      for (let k = 0; k < xs.length; k++) {
        const s = vs[k] > tol ? 1 : vs[k] < -tol ? -1 : 0;
        if (!s) continue;
        if (last && s !== last.s) {
          const lo = last.x, hi = xs[k];
          expect(a.breakevens.some(b => b >= lo - 1e-9 && b <= hi + 1e-9),
                 `${ctx}\nP&L changes sign between ${lo} and ${hi} but no break-even is reported there`).toBe(true);
        }
        last = { x: xs[k], s };
      }
    }
  });

  test('mixed-expiry break-evens are real zero crossings of the first-expiry P&L', () => {
    const g = rng(8);
    for (let i = 0; i < 150; i++) {
      const m = randomMarket(g);
      const legs = randomLegs(g, m, false);
      if (legs.every(l => Math.abs(l.T - legs[0].T) < 1e-9)) continue;
      const a = payoffAnalytics(legs, m);
      const f = (x: number) => pnlAtFirstExpiry(legs, { ...m, S: x });
      const h = (4 * Math.max(m.S, ...legs.map(l => l.K))) / 2400;
      for (const b of a.breakevens) {
        const lo = f(Math.max(0, b - h)), hi = f(b + h);
        expect(lo * hi <= 0 || Math.abs(f(b)) < 1e-6 * legs.reduce((s, l) => s + l.qty * M * m.S, 0),
               JSON.stringify({ m, legs, b })).toBe(true);
      }
    }
  });

  test('stress: leg P&L sums to the total, no shock means no P&L, surface centre is zero', () => {
    const g = rng(9);
    for (let i = 0; i < 300; i++) {
      const m = randomMarket(g);
      const legs = randomLegs(g, m, false);
      const shock = g.u() < 0.3 ? g.pick(SCENARIOS).shock
        : { spotPct: g.range(-50, 50), volPts: g.range(-30, 80), volMult: g.pick([1, 0.6, 1.4]), rateBp: g.range(-300, 300), days: g.int(0, 30) };
      const rep = stressReport(legs, m, shock);
      const size = legs.reduce((a, l) => a + l.qty * M * m.S, 0);
      const ctx = JSON.stringify({ m, legs, shock });
      expect(Number.isFinite(rep.pnl), ctx).toBe(true);
      expect(Math.abs(rep.pnlByLeg.reduce((a, b) => a + b, 0) - rep.pnl), ctx).toBeLessThan(1e-9 * size);
      expect(rep.after.sigma, ctx).toBeGreaterThan(0);
      expect(rep.after.r, ctx).toBeGreaterThanOrEqual(0);
      expect(stressReport(legs, m, NO_SHOCK).pnl, ctx).toBe(0);
      expect(pnlSurface(legs, m)[2][2], ctx).toBe(0);
    }
  });

  test('VaR: non-negative, √h scaling, ES ≥ VaR, zero vol-of-vol equals one-factor', () => {
    const g = rng(10);
    for (let i = 0; i < 40; i++) {
      const m = randomMarket(g);
      const legs = randomLegs(g, m, false, 3 / 365);
      const dn1 = deltaNormalVaR(legs, m, 0.95, 1), dn10 = deltaNormalVaR(legs, m, 0.95, 10);
      expect(dn1).toBeGreaterThanOrEqual(0);
      if (dn1 > 0) expect(dn10 / dn1).toBeCloseTo(Math.sqrt(10), 9);
      const one = mcVaR(legs, m, 0.95, 1, 4000, i);
      const two0 = mcVaR(legs, m, 0.95, 1, 4000, i, { volOfVol: 0, rho: -0.7 });
      expect(one.var).toBeGreaterThanOrEqual(0);
      expect(one.es).toBeGreaterThanOrEqual(one.var - 1e-9);
      expect(two0.var).toBe(one.var);
      expect(finite({ var: one.var, es: one.es, lo: one.lo, hi: one.hi })).toBe(true);
    }
  });
});

test.describe('property: import and formatting', () => {
  const quote = (cell: string) => (/[",;\t|\n\r]|^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

  test('CSV round trip: quoted delimiters, quotes, newlines and unicode survive', () => {
    const g = rng(11);
    const alphabet = ['a', 'Z', '7', ' ', ',', ';', '"', '\n', '\r\n', '\t', '|', 'é', '€', '−', '$', '(', ')', '.'];
    for (let i = 0; i < 400; i++) {
      const rows = g.int(1, 12), cols = g.int(1, 8);
      const table = Array.from({ length: rows }, () => Array.from({ length: cols }, () =>
        Array.from({ length: g.int(0, 10) }, () => g.pick(alphabet)).join('')));
      // a fully empty trailing row is indistinguishable from a trailing newline
      if (table[rows - 1].every(c => c === '')) table[rows - 1][0] = 'x';
      const text = table.map(r => r.map(quote).join(',')).join(g.pick(['\n', '\r\n']));
      expect(parseCsvText(text), JSON.stringify(text)).toEqual(table);
    }
  });

  test('importing random tables never throws and only yields valid legs', () => {
    const g = rng(12);
    const headers = ['type', 'Option Type', 'cp', 'side', 'Action', 'strike', 'Strike Price', 'k', 'days', 'DTE', 'expiry',
                     'Expiration', 'years', 'qty', 'Contracts', 'position', 'premium', 'Fill Price', 'symbol', 'notes', ''];
    const tokens: unknown[] = ['call', 'PUT', 'c', 'p', 'Short Put', 'long call', 'buy', 'SELL', 'sto', 'maybe', '(5)', '-3',
      '0', '-0', '12', '755', '$1,234.50', '12,5', '1e309', 'NaN', 'Infinity', '', '   ', '#note', 'abc', '2026-12-18',
      '12/18/2026', 'Dec 18 2026', '2026-02-30', 46374, 30, 0.25, -1, 1e6, new Date(2026, 11, 18), null, undefined, true];
    const today = new Date(2026, 8, 13);
    const market: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0 };
    for (let i = 0; i < 1500; i++) {
      const cols = g.int(0, 9), rows = g.int(0, 14);
      const table: unknown[][] = [];
      if (g.u() < 0.7) table.push(Array.from({ length: cols }, () => g.pick(headers)));
      for (let r = 0; r < rows; r++) table.push(Array.from({ length: g.int(0, cols + 2) }, () => g.pick(tokens)));
      let res: ReturnType<typeof importPortfolio> | undefined;
      expect(() => { res = importPortfolio(table, { market, today, instrument: 'SPY' }); }, JSON.stringify(table)).not.toThrow();
      const out = res!;
      expect(out.legs.length).toBeLessThanOrEqual(8);
      for (const l of out.legs) {
        const ctx = JSON.stringify({ table, leg: l });
        expect(typeof l.call, ctx).toBe('boolean');
        expect(['buy', 'sell'], ctx).toContain(l.side);
        expect(Number.isFinite(l.qty) && l.qty > 0, ctx).toBe(true);
        expect(Number.isFinite(l.K) && l.K > 0, ctx).toBe(true);
        expect(Number.isFinite(l.T) && l.T > 0 && l.T <= 3.01, ctx).toBe(true);
        expect(Number.isFinite(l.premium) && l.premium >= 0, ctx).toBe(true);
      }
      if (out.summary) expect(out.summary.positions).toBe(out.legs.length);
      else expect(out.legs.length).toBe(0);
    }
  });

  test('chart ticks are sorted, unique and bounded for any range, including degenerate ones', () => {
    const g = rng(14);
    // the range that produced duplicate React keys in the random UI walk (seed 101)
    expect(new Set(niceTicks(-21.92627312550001, -21.9262731254999, 4)).size)
      .toBe(niceTicks(-21.92627312550001, -21.9262731254999, 4).length);
    const bad: unknown[] = [];
    for (let i = 0; i < 20_000; i++) {
      const mag = g.pick([1e-12, 1e-6, 1, 1e3, 1e9]);
      const lo = g.range(-100, 100) * mag;
      const width = g.pick([0, 1e-16, 1e-13, 1e-10, 1e-8, 1e-3, 1, 1e4]) * mag * g.u();
      const count = g.int(2, 8);
      const ticks = niceTicks(lo, lo + width, count);
      const ok = ticks.length >= 1 && ticks.length <= 4 * count + 1 && ticks.every(Number.isFinite) &&
                 ticks.every((t, k) => k === 0 || t > ticks[k - 1]);
      if (!ok) bad.push({ lo, width, count, ticks });
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('strike labels show the listed strike exactly', () => {
    // PLTR iron condor strikes were drawn as "K 158 · K 163" by the rounding axis formatter
    expect([157.5, 162.5, 485, 2.25, 0.5, 10250, 1052.5].map(strikeTick))
      .toEqual(['157.5', '162.5', '485', '2.25', '0.5', '10,250', '1,052.5']);
    const g = rng(15);
    const bad: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const K = +(g.logRange(0.05, 50_000) / 0.05).toFixed(0) * 0.05;   // any strike on a 0.05 grid
      const shown = strikeTick(K);
      if (Math.abs(+shown.replace(/,/g, '') - K) > 1e-9) bad.push(`${K} → ${shown}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('formatters never render NaN or undefined for finite values', () => {
    const g = rng(13);
    const bad: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const v = g.pick([0, -0, 1e-12, -1e-12, 0.4999, -0.5, 1e15, -1e15]) * (g.u() < 0.5 ? 1 : 0) + g.range(-1e7, 1e7) * g.pick([0, 1e-9, 1]);
      for (const s of [usd(v), usd(v, 2), usdSigned(v), usdSigned(v, 2), usdCompact(v), num(v, 3), signed(v, 2), pct(v, 2),
                       fixed(v, 0), fixed(v, 4)]) {
        if (/NaN|undefined/.test(s)) bad.push(`${v} → ${s}`);
        // a value that rounds to zero must not keep its minus sign ("−0", "−$0.00", "-0.0000")
        if (/^[−-]\$?0(\.0+)?[%kM]?$/.test(s)) bad.push(`${v} → signed zero ${s}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

test.describe('property: volatility smile', () => {
  test('with a smile, every revaluation path agrees with the Greeks tiles at zero shock', () => {
    const g = rng(20);
    const bad: string[] = [];
    for (let i = 0; i < 300; i++) {
      const m: Market = { ...randomMarket(g), smile: randomSmile(g) };
      const legs = randomLegs(g, m, g.u() < 0.5);
      const tiles = portfolioGreeks(legs, m).price;
      const tol = 1e-9 * Math.max(1, Math.abs(tiles));
      const checks: [string, number][] = [
        ['portfolioValue', portfolioValue(legs, m)],
        ['sticky-strike scenario at today’s spot', portfolioValue(legs, atSpot(m, m.S))],
        ['stress with no shock', stressReport(legs, m, NO_SHOCK).after.value],
        ['P&L surface centre', portfolioValue(legs, m) + pnlSurface(legs, m)[2][2]],
      ];
      for (const [name, v] of checks) if (!(Math.abs(v - tiles) <= tol)) bad.push(`${name}: ${v} vs tiles ${tiles}`);
      const one = mcVaR(legs, m, 0.95, 1, 2000, 7), twoAtZero = mcVaR(legs, m, 0.95, 1, 2000, 7, { volOfVol: 0, rho: -0.7 });
      if (one.var !== twoAtZero.var) bad.push(`VaR: one-factor ${one.var} vs two-factor ν=0 ${twoAtZero.var}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('with a smile, delta and gamma are sticky-strike derivatives of portfolio value', () => {
    const g = rng(21);
    const bad: string[] = [];
    for (let i = 0; i < 200; i++) {
      const m: Market = { ...randomMarket(g), smile: randomSmile(g) };
      const legs = randomLegs(g, m, false, 7 / 365);
      const gk = portfolioGreeks(legs, m);
      const size = legs.reduce((a, l) => a + l.qty * M, 0);
      const V = (S: number) => portfolioValue(legs, atSpot(m, S));
      // bumps scaled to the narrowest leg distribution, S·σ_leg·√T (see the flat-market test)
      const width = m.S * Math.min(...legs.map(l => legSigma(m, l.K, l.T) * Math.sqrt(l.T)));
      const hS = 1e-3 * width, hG = 2e-2 * width;
      const delta = (V(m.S + hS) - V(m.S - hS)) / (2 * hS);
      const D2 = (h: number) => (V(m.S + h) - 2 * V(m.S) + V(m.S - h)) / (h * h);
      const gamma = (4 * D2(hG / 2) - D2(hG)) / 3;
      const ctx = JSON.stringify({ m, legs });
      if (Math.abs(gk.delta - delta) > 1e-5 * size) bad.push(`delta ${gk.delta} vs ${delta} ${ctx}`);
      if (Math.abs(gk.gamma - gamma) > 1e-4 * Math.abs(gk.gamma) + 1e-6 * size / m.S) bad.push(`gamma ${gk.gamma} vs ${gamma} ${ctx}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('with a smile, portfolio Monte Carlo converges to the smile Black-Scholes value', () => {
    const g = rng(22);
    const bad: string[] = [];
    for (let i = 0; i < 12; i++) {
      const m: Market = { ...randomMarket(g), smile: randomSmile(g) };
      const legs = randomLegs(g, m, g.u() < 0.5, 7 / 365);
      const ref = portfolioValue(legs, m);
      const mc = mcPortfolio(legs, m, 100_000, 1000 + i);
      const z = mc.se > 0 ? Math.abs(mc.price - ref) / mc.se : Math.abs(mc.price - ref) < 1e-9 ? 0 : Infinity;
      if (!(z < 4)) bad.push(`|z| ${z.toFixed(2)}: MC ${mc.price} ± ${mc.se} vs ${ref} ${JSON.stringify({ m, legs })}`);
    }
    expect(bad).toEqual([]);
  });

  test('with an ATM term structure (and a smile or not), mixed-expiry portfolios revalue consistently and Monte Carlo converges', () => {
    const g = rng(23);
    const bad: string[] = [];
    const DAYS = [7, 30, 90, 365];
    const randomTerm = (): TermStructure => {
      if (g.u() < 0.5) return { kind: 'curve', ratio: g.logRange(0.4, 2.5), halfLife: g.logRange(3 / 365, 1) };
      const theta: number[] = [];
      DAYS.forEach((d, i) => theta.push(Math.max(theta[i - 1] ?? 0, g.logRange(0.08, 0.4) ** 2 * (d / 365))));
      return fittedTerm(DAYS.map(d => d / 365), theta)!.term;
    };
    for (let i = 0; i < 200; i++) {
      const m: Market = { ...randomMarket(g), term: randomTerm(), ...(g.u() < 0.6 ? { smile: randomSmile(g) } : {}) };
      m.sigma = Math.min(m.sigma, 0.8);
      const legs = randomLegs(g, m, false, 7 / 365);   // mixed expiries: each leg reads its own ATM volatility
      const gk = portfolioGreeks(legs, m);
      const tol = 1e-9 * Math.max(1, Math.abs(gk.price));
      const ctx = JSON.stringify({ m, legs });
      const checks: [string, number][] = [
        ['portfolioValue', portfolioValue(legs, m)],
        ['sticky-strike scenario at today’s spot', portfolioValue(legs, atSpot(m, m.S))],
        ['stress with no shock', stressReport(legs, m, NO_SHOCK).after.value],
        ['P&L surface centre', portfolioValue(legs, m) + pnlSurface(legs, m)[2][2]],
      ];
      for (const [name, v] of checks) if (!(Math.abs(v - gk.price) <= tol)) bad.push(`${name}: ${v} vs tiles ${gk.price} ${ctx}`);
      const one = mcVaR(legs, m, 0.95, 1, 2000, 7), twoAtZero = mcVaR(legs, m, 0.95, 1, 2000, 7, { volOfVol: 0, rho: -0.7 });
      if (one.var !== twoAtZero.var) bad.push(`VaR: one-factor ${one.var} vs two-factor ν=0 ${twoAtZero.var}`);

      const size = legs.reduce((a, l) => a + l.qty * M, 0);
      const V = (S: number) => portfolioValue(legs, atSpot(m, S));
      const width = m.S * Math.min(...legs.map(l => legSigma(m, l.K, l.T) * Math.sqrt(l.T)));
      const hS = 1e-3 * width;
      const delta = (V(m.S + hS) - V(m.S - hS)) / (2 * hS);
      if (Math.abs(gk.delta - delta) > 1e-5 * size) bad.push(`delta ${gk.delta} vs ${delta} ${ctx}`);

      if (i < 12) {
        const mc = mcPortfolio(legs, m, 100_000, 3000 + i);
        const z = mc.se > 0 ? Math.abs(mc.price - gk.price) / mc.se : Math.abs(mc.price - gk.price) < 1e-9 ? 0 : Infinity;
        if (!(z < 4)) bad.push(`|z| ${z.toFixed(2)}: MC ${mc.price} ± ${mc.se} vs ${gk.price} ${ctx}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
