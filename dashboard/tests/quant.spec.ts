/**
 * Unit tests for the terminal's pricing, strategy, risk and import libraries.
 * Run with `npm run test:unit` (Node only — no browser, no dev server).
 *
 * Reference values come from textbooks (Hull), closed-form identities
 * (put-call parity), finite differences, and the C++ core itself via its
 * Python bindings — never from the TypeScript code under test.
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';
import * as XLSX from 'xlsx';

import { bsGreeks, bsPrice, probItm } from '../lib/quant/blackScholes';
import { crrPrice } from '../lib/quant/binomial';
import { mcPortfolio, terminalDistribution } from '../lib/quant/monteCarlo';
import { normCdf, normInv } from '../lib/quant/normal';
import { mulberry32 } from '../lib/quant/rng';
import type { Leg, Market, Side } from '../lib/quant/types';
import { payoffAnalytics, pnlAtFirstExpiry, portfolioValue } from '../lib/strategy/portfolio';
import { buildPreset, MAX_LEGS, PRESETS } from '../lib/strategy/presets';
import { findInstrument, INSTRUMENTS } from '../lib/market/instruments';
import { deltaGammaVaR, deltaNormalVaR, mcVaR, TRADING_DAYS } from '../lib/risk/var';
import { applyShock, SCENARIOS, stressReport } from '../lib/risk/stress';
import { pnlSurface } from '../lib/risk/surface';
import { importPortfolio, parseCsvText, parseExpiryDays, parseNumber } from '../lib/io/portfolioParser';
import { readSpreadsheet } from '../lib/io/spreadsheet';
import { SAMPLE_CSV, SAMPLE_ROWS } from '../lib/io/samples';

let legSeq = 0;
const leg = (call: boolean, side: Side, K: number, T: number, qty = 1, premium = 0): Leg =>
  ({ id: `t${legSeq++}`, call, side, qty, K, T, premium });

const mkt = (S: number, sigma: number, r: number, q = 0): Market => ({ S, sigma, r, q });

// ── C++ reference (python bindings) ─────────────────────────────────────────

const PY = '/Library/Developer/CommandLineTools/usr/bin/python3';
const PY_DIR = path.resolve(__dirname, '..', '..', 'python');

function engineGreeks(call: boolean, S: number, K: number, r: number, sigma: number, T: number) {
  const script = `import sys, json; sys.path.insert(0, r"${PY_DIR}"); import quantcore; ` +
    `print(json.dumps(quantcore.bs_full(${call ? 0 : 1}, ${S}, ${K}, ${r}, ${sigma}, ${T})))`;
  return JSON.parse(execSync(`${PY} -c '${script}'`).toString().trim()) as
    { price: number; delta: number; gamma: number; theta: number; vega: number };
}

function engineAvailable(): boolean {
  try { engineGreeks(true, 100, 100, 0.05, 0.2, 1); return true; } catch { return false; }
}

// ── normal distribution ─────────────────────────────────────────────────────

test.describe('normal distribution', () => {
  test('inverse CDF matches known quantiles and round-trips', () => {
    expect(normInv(0.95)).toBeCloseTo(1.6448536, 6);
    expect(normInv(0.99)).toBeCloseTo(2.3263479, 6);
    expect(normInv(0.5)).toBeCloseTo(0, 12);
    for (const p of [0.001, 0.02, 0.1, 0.5, 0.9, 0.975, 0.999]) {
      expect(Math.abs(normCdf(normInv(p)) - p)).toBeLessThan(1e-7);   // A&S 26.2.17 bound 7.5e-8
    }
  });

  test('CDF symmetry is exact', () => {
    for (const x of [-3, -1.2, -0.1, 0.4, 2.5]) expect(normCdf(x) + normCdf(-x)).toBe(1);
  });
});

// ── Black-Scholes ───────────────────────────────────────────────────────────

test.describe('Black-Scholes-Merton', () => {
  test('Hull 9e example 15.6: S=42 K=40 r=10% σ=20% T=0.5', () => {
    expect(bsPrice(true, 42, 40, 0.5, 0.2, 0.1)).toBeCloseTo(4.7594, 4);
    expect(bsPrice(false, 42, 40, 0.5, 0.2, 0.1)).toBeCloseTo(0.8086, 4);
  });

  test('matches the C++ core (bs_full) on price and all Greeks', () => {
    test.skip(!engineAvailable(), 'quantcore python module not built');
    const cases: [boolean, number, number, number, number, number][] = [
      [true, 756.48, 755, 0.045, 0.138, 0.129],   // canonical engine contract
      [false, 756.48, 755, 0.045, 0.138, 0.129],
      [true, 42, 40, 0.1, 0.2, 0.5],
      [false, 142.35, 150, 0.03, 0.38, 0.6],
    ];
    for (const [call, S, K, r, sigma, T] of cases) {
      const ref = engineGreeks(call, S, K, r, sigma, T);
      const g = bsGreeks(call, S, K, T, sigma, r, 0);
      // Tolerances follow the A&S normal-CDF error bound (7.5e-8) scaled by S and K.
      const nTol = 7.5e-8 * 2;
      expect(Math.abs(g.price - ref.price)).toBeLessThan((S + K) * nTol);
      expect(Math.abs(g.delta - ref.delta)).toBeLessThan(nTol);
      expect(Math.abs(g.gamma - ref.gamma)).toBeLessThan(1e-9);
      expect(Math.abs(g.theta - ref.theta)).toBeLessThan((S * sigma + r * K) * nTol + 1e-9);
      expect(Math.abs(g.vega - ref.vega)).toBeLessThan(1e-7 * Math.max(1, ref.vega));
    }
  });

  test('put-call parity holds with a dividend yield', () => {
    const cases = [[100, 95, 0.5, 0.25, 0.05, 0.02], [756.48, 800, 0.129, 0.138, 0.045, 0.013],
                   [20, 30, 2, 0.8, 0.01, 0.06]];
    for (const [S, K, T, sigma, r, q] of cases) {
      const c = bsPrice(true, S, K, T, sigma, r, q), p = bsPrice(false, S, K, T, sigma, r, q);
      expect(c - p).toBeCloseTo(S * Math.exp(-q * T) - K * Math.exp(-r * T), 9);
    }
  });

  test('analytic Greeks agree with finite differences (q ≠ 0)', () => {
    const [S, K, T, sigma, r, q] = [100, 105, 0.75, 0.25, 0.04, 0.02];
    for (const call of [true, false]) {
      const g = bsGreeks(call, S, K, T, sigma, r, q);
      const P = (s = S, t = T, v = sigma) => bsPrice(call, s, K, t, v, r, q);
      const hS = 0.01, hG = 0.5, hV = 1e-4, hT = 1e-5;
      expect(g.price).toBeCloseTo(P(), 12);
      expect(Math.abs(g.delta - (P(S + hS) - P(S - hS)) / (2 * hS))).toBeLessThan(1e-5);
      expect(Math.abs(g.gamma - (P(S + hG) - 2 * P() + P(S - hG)) / (hG * hG))).toBeLessThan(1e-5);
      expect(Math.abs(g.vega - (P(S, T, sigma + hV) - P(S, T, sigma - hV)) / (2 * hV))).toBeLessThan(1e-3);
      // theta = dV/dt = −dV/dT
      expect(Math.abs(g.theta + (P(S, T + hT) - P(S, T - hT)) / (2 * hT))).toBeLessThan(1e-3);
    }
  });

  test('expired and zero-vol limits', () => {
    expect(bsPrice(true, 110, 100, 0, 0.2, 0.05)).toBe(10);
    expect(bsPrice(false, 110, 100, 0, 0.2, 0.05)).toBe(0);
    expect(bsGreeks(true, 110, 100, 0, 0.2, 0.05).delta).toBe(1);
    expect(bsPrice(true, 100, 100, 1, 0, 0.05)).toBeCloseTo(100 - 100 * Math.exp(-0.05), 12);
  });
});

// ── binomial ────────────────────────────────────────────────────────────────

test.describe('CRR binomial (512 steps)', () => {
  test('converges to Black-Scholes within $0.01', () => {
    const cases: [boolean, number, number, number, number, number, number][] = [
      [true, 100, 100, 0.5, 0.2, 0.05, 0], [false, 100, 100, 0.5, 0.2, 0.05, 0],
      [true, 100, 110, 1, 0.3, 0.03, 0.02], [false, 100, 90, 0.25, 0.4, 0.01, 0.01],
      [true, 42, 40, 0.5, 0.2, 0.1, 0],
    ];
    for (const [call, S, K, T, sigma, r, q] of cases) {
      expect(Math.abs(crrPrice(call, S, K, T, sigma, r, q) - bsPrice(call, S, K, T, sigma, r, q)))
        .toBeLessThan(0.01);
    }
  });

  test('error shrinks as steps increase', () => {
    const bs = bsPrice(true, 100, 100, 0.5, 0.2, 0.05);
    const err = (n: number) => Math.abs(crrPrice(true, 100, 100, 0.5, 0.2, 0.05, 0, n) - bs);
    expect(err(512)).toBeLessThan(err(64));
    expect(err(64)).toBeLessThan(err(8));
  });
});

// ── Monte Carlo ─────────────────────────────────────────────────────────────

test.describe('Monte Carlo', () => {
  const m = mkt(100, 0.25, 0.04, 0.01);

  test('single call is within 3 standard errors of Black-Scholes across seeds', () => {
    const legs = [leg(true, 'buy', 105, 0.5)];
    const ref = portfolioValue(legs, m.S, m.sigma, m.r, m.q);
    for (const seed of [1, 7, 42, 1234, 99991]) {
      const res = mcPortfolio(legs, m, 50_000, seed);
      expect(Math.abs(res.price - ref)).toBeLessThan(3 * res.se);
    }
  });

  test('is deterministic per seed and differs across seeds', () => {
    const legs = [leg(false, 'buy', 95, 0.3, 2)];
    const a = mcPortfolio(legs, m, 20_000, 42), b = mcPortfolio(legs, m, 20_000, 42);
    const c = mcPortfolio(legs, m, 20_000, 43);
    expect(a.price).toBe(b.price);
    expect(a.se).toBe(b.se);
    expect(a.price).not.toBe(c.price);
    const u1 = mulberry32(5), u2 = mulberry32(5);
    for (let i = 0; i < 5; i++) expect(u1()).toBe(u2());
  });

  test('antithetic variates reduce the standard error of a call', () => {
    const legs = [leg(true, 'buy', 100, 0.5)];
    const plain = mcPortfolio(legs, m, 50_000, 42, false);
    const anti = mcPortfolio(legs, m, 50_000, 42, true);
    expect(anti.paths).toBe(50_000);
    expect(anti.se).toBeLessThan(plain.se);
  });

  test('standard error falls roughly as 1/√N and checkpoints are recorded', () => {
    const legs = [leg(true, 'buy', 100, 0.5)];
    const res = mcPortfolio(legs, m, 200_000, 42, false, [1_000, 10_000, 100_000, 200_000]);
    expect(res.checkpoints.map(c => c.paths)).toEqual([1_000, 10_000, 100_000, 200_000]);
    const ratio = res.checkpoints[0].se / res.checkpoints[2].se;        // √100 = 10
    expect(ratio).toBeGreaterThan(8);
    expect(ratio).toBeLessThan(12.5);
  });

  test('mixed-expiry calendar spread is within 3 SE of the analytic value', () => {
    const legs = [leg(true, 'sell', 100, 0.1, 3), leg(true, 'buy', 100, 0.6, 3)];
    const ref = portfolioValue(legs, m.S, m.sigma, m.r, m.q);
    const res = mcPortfolio(legs, m, 100_000, 2024);
    expect(Math.abs(res.price - ref)).toBeLessThan(3 * res.se);
  });

  test('terminal distribution: mean ≈ forward, P(ITM) ≈ N(d2)', () => {
    const T = 0.5, K = 105;
    const d = terminalDistribution(m, T, 200_000, 40, 42, { K, call: true });
    const fwd = m.S * Math.exp((m.r - m.q) * T);
    expect(Math.abs(d.mean - fwd) / fwd).toBeLessThan(0.002);
    const p = probItm(true, m.S, K, T, m.sigma, m.r, m.q);
    const seP = Math.sqrt(p * (1 - p) / d.samples);
    expect(Math.abs(d.pItm! - p)).toBeLessThan(3 * seP);
    expect(d.bins).toHaveLength(40);
  });
});

// ── strategy analytics ──────────────────────────────────────────────────────

test.describe('payoff analytics', () => {
  const m = mkt(100, 0.2, 0.05);
  const T = 0.25;

  test('bull call spread: bounded profit and loss, one break-even', () => {
    const a = payoffAnalytics([leg(true, 'buy', 100, T, 1, 5), leg(true, 'sell', 110, T, 1, 2)], m);
    expect(a.exact).toBe(true);
    expect(a.maxLoss).toBeCloseTo(-300, 9);
    expect(a.maxProfit).toBeCloseTo(700, 9);
    expect(a.maxProfitUnbounded || a.maxLossUnbounded).toBe(false);
    expect(a.breakevens).toHaveLength(1);
    expect(a.breakevens[0]).toBeCloseTo(103, 9);
  });

  test('iron condor: credit is max profit, wings cap the loss, two break-evens', () => {
    const legs = [leg(false, 'buy', 90, T, 1, 1), leg(false, 'sell', 95, T, 1, 2),
                  leg(true, 'sell', 105, T, 1, 2), leg(true, 'buy', 110, T, 1, 1)];
    const a = payoffAnalytics(legs, m);
    expect(a.maxProfit).toBeCloseTo(200, 9);
    expect(a.maxLoss).toBeCloseTo(-300, 9);
    expect(a.breakevens.map(x => +x.toFixed(9))).toEqual([93, 107]);
  });

  test('long call is unbounded up; short call is unbounded down', () => {
    const long = payoffAnalytics([leg(true, 'buy', 100, T, 1, 5)], m);
    expect(long.maxProfitUnbounded).toBe(true);
    expect(long.maxProfit).toBe(Infinity);
    expect(long.maxLoss).toBeCloseTo(-500, 9);
    expect(long.breakevens).toEqual([105]);
    const short = payoffAnalytics([leg(true, 'sell', 100, T, 1, 5)], m);
    expect(short.maxLossUnbounded).toBe(true);
    expect(short.maxProfit).toBeCloseTo(500, 9);
    expect(short.breakevens).toEqual([105]);
  });

  test('long put profit is bounded at S = 0; straddle has two break-evens', () => {
    const put = payoffAnalytics([leg(false, 'buy', 100, T, 1, 4)], m);
    expect(put.maxProfitUnbounded).toBe(false);
    expect(put.maxProfit).toBeCloseTo(9600, 9);
    expect(put.breakevens).toEqual([96]);
    const straddle = payoffAnalytics([leg(true, 'buy', 100, T, 1, 5), leg(false, 'buy', 100, T, 1, 5)], m);
    expect(straddle.breakevens).toEqual([90, 110]);
    expect(straddle.maxLoss).toBeCloseTo(-1000, 9);
  });

  test('mixed expiries: later legs keep their time value at the first expiry', () => {
    const legs = [leg(true, 'sell', 100, 0.1, 1, 3), leg(true, 'buy', 100, 0.5, 1, 6)];
    const a = payoffAnalytics(legs, m);
    expect(a.exact).toBe(false);
    expect(a.horizonT).toBeCloseTo(0.1, 12);
    const atK = pnlAtFirstExpiry(legs, 100, m.sigma, m.r, m.q);
    const expected = 100 * ((0 - 3) * -1 + (bsPrice(true, 100, 100, 0.4, m.sigma, m.r) - 6));
    expect(atK).toBeCloseTo(expected, 9);
    expect(a.breakevens.length).toBe(2);
  });

  test('every preset builds on every instrument within the leg limit', () => {
    for (const inst of INSTRUMENTS) {
      const im = mkt(inst.spot, inst.vol, 0.045);
      for (const name of PRESETS) {
        const legs = buildPreset(name, inst, im);
        expect(legs.length).toBeGreaterThan(0);
        expect(legs.length).toBeLessThanOrEqual(MAX_LEGS);
        for (const l of legs) {
          expect(l.K % inst.kstep).toBeCloseTo(0, 9);
          expect(l.premium).toBeGreaterThan(0);
        }
      }
    }
    const nvda = findInstrument('NVDA')!;
    const condor = buildPreset('Iron Condor', nvda, mkt(nvda.spot, nvda.vol, 0.045));
    expect(condor.map(l => [l.call, l.side])).toEqual([[false, 'buy'], [false, 'sell'], [true, 'sell'], [true, 'buy']]);
    const ks = condor.map(l => l.K);
    expect(ks[1] - ks[0]).toBeCloseTo(ks[3] - ks[2], 9);
    const a = payoffAnalytics(condor, mkt(nvda.spot, nvda.vol, 0.045));
    expect(a.maxProfitUnbounded || a.maxLossUnbounded).toBe(false);
    expect(a.breakevens).toHaveLength(2);
  });
});

// ── risk ────────────────────────────────────────────────────────────────────

test.describe('VaR', () => {
  const m = mkt(756.48, 0.138, 0.045);
  const legs = [leg(true, 'buy', 755, 0.129, 10)];

  test('delta-normal VaR equals z·|Δ·S|·σ√(h/252) and scales with z and √h', () => {
    const delta = bsGreeks(true, m.S, 755, 0.129, m.sigma, m.r).delta * 1000;
    const hand = 1.6448536269514722 * Math.abs(delta * m.S) * m.sigma * Math.sqrt(1 / TRADING_DAYS);
    const v1 = deltaNormalVaR(legs, m, 0.95, 1);
    expect(v1).toBeCloseTo(hand, 4);
    expect(deltaNormalVaR(legs, m, 0.95, 10) / v1).toBeCloseTo(Math.sqrt(10), 9);
    expect(deltaNormalVaR(legs, m, 0.99, 1) / v1).toBeCloseTo(normInv(0.99) / normInv(0.95), 9);
  });

  test('long option: convexity makes delta-gamma VaR smaller than delta-normal', () => {
    expect(deltaGammaVaR(legs, m, 0.95, 1)).toBeLessThan(deltaNormalVaR(legs, m, 0.95, 1));
  });

  test('MC full-revaluation VaR: ES ≥ VaR, deterministic, consistent with delta-gamma', () => {
    const a = mcVaR(legs, m, 0.95, 1, 20_000, 42);
    const b = mcVaR(legs, m, 0.95, 1, 20_000, 42);
    expect(a.var).toBe(b.var);
    expect(a.var).toBeGreaterThan(0);
    expect(a.es).toBeGreaterThanOrEqual(a.var);
    const dg = deltaGammaVaR(legs, m, 0.95, 1);
    expect(Math.abs(a.var - dg) / dg).toBeLessThan(0.15);
    expect(mcVaR(legs, m, 0.99, 1, 20_000, 42).var).toBeGreaterThan(a.var);
  });
});

test.describe('stress and surface', () => {
  const m = mkt(100, 0.2, 0.045);

  test('applyShock: spot, vol points, vol multiplier and the zero rate floor', () => {
    const covid = SCENARIOS.find(s => s.id === 'covid')!;
    const s = applyShock(m, covid.shock);
    expect(s.S).toBeCloseTo(70, 12);
    expect(s.sigma).toBeCloseTo(0.75, 12);
    expect(s.r).toBeCloseTo(0.03, 12);
    expect(applyShock(mkt(100, 0.2, 0.01), { spotPct: 0, volPts: 0, volMult: 1, rateBp: -200, days: 0 }).r).toBe(0);
    expect(applyShock(m, SCENARIOS.find(x => x.id === 'meltup')!.shock).sigma).toBeCloseTo(0.12, 12);
  });

  test('full revaluation: leg P&L sums to total; puts gain and calls lose in a crash', () => {
    const legs = [leg(false, 'buy', 95, 0.25, 2, 2), leg(true, 'buy', 105, 0.25, 1, 2)];
    for (const sc of SCENARIOS) {
      const rep = stressReport(legs, m, { ...sc.shock, days: 5 });
      expect(rep.pnlByLeg.reduce((a, b) => a + b, 0)).toBeCloseTo(rep.pnl, 8);
      expect(rep.ladder).toHaveLength(17);
    }
    const crash = stressReport(legs, m, SCENARIOS.find(s => s.id === 'gfc')!.shock);
    expect(crash.pnlByLeg[0]).toBeGreaterThan(0);
    expect(crash.after.S).toBeCloseTo(65, 12);
    expect(crash.after.var95).not.toBe(crash.before.var95);
  });

  test('P&L surface: zero at the centre, long call gains up-spot/up-vol', () => {
    const grid = pnlSurface([leg(true, 'buy', 100, 0.25, 10)], m);
    expect(grid[2][2]).toBeCloseTo(0, 9);
    expect(grid[4][4]).toBeGreaterThan(grid[2][2]);
    expect(grid[0][0]).toBeLessThan(grid[2][2]);
  });
});

// ── portfolio import ────────────────────────────────────────────────────────

test.describe('portfolio import', () => {
  const market = mkt(756.48, 0.138, 0.045);
  const today = new Date(2026, 8, 13);   // 13 Sep 2026, local midnight

  test('number parsing: currency, thousands, accounting negatives, percent', () => {
    expect(parseNumber('$1,234.50')).toBe(1234.5);
    expect(parseNumber('1,234')).toBe(1234);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber('€1.234,50')).toBe(1234.5);
    expect(parseNumber('(5)')).toBe(-5);
    expect(parseNumber(' 12% ')).toBe(12);
    expect(parseNumber('-3e2')).toBe(-300);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });

  test('expiry dates: ISO, US, textual, Date objects and Excel serials', () => {
    expect(parseExpiryDays('2026-12-18', today)).toBe(96);
    expect(parseExpiryDays('12/18/2026', today)).toBe(96);
    expect(parseExpiryDays('Dec 18 2026', today)).toBe(96);
    expect(parseExpiryDays(new Date(2026, 11, 18), today)).toBe(96);
    const serial = (Date.UTC(2026, 11, 18) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(serial).toBe(46374);
    expect(parseExpiryDays(serial, today)).toBe(96);
    expect(parseExpiryDays('2026-02-30', today)).toBeNull();
  });

  test('aliased headers, quoted commas, BOM and semicolons', () => {
    const csv = '﻿Option Type;Action;Strike Price;Expiration Date;Contracts;Fill Price\n' +
                'Call;BUY;"1,000";2026-12-18;3;"$12,50"\n' +
                'P;sold;740;12/18/2026;(2);4.10\n';
    const table = parseCsvText(csv);
    expect(table[0][0]).toBe('Option Type');
    const res = importPortfolio(table, { market, today });
    expect(res.errors).toEqual([]);
    expect(res.mapping).toMatchObject({ type: 'Option Type', side: 'Action', strike: 'Strike Price',
                                        expiry: 'Expiration Date', qty: 'Contracts', premium: 'Fill Price' });
    expect(res.legs).toHaveLength(2);
    // "1,000" is a thousands separator; "$12,50" can only be a decimal comma
    expect(res.legs[0]).toMatchObject({ call: true, side: 'buy', K: 1000, qty: 3, premium: 12.5 });
    expect(res.legs[0].T).toBeCloseTo(96 / 365, 12);
    expect(res.legs[1]).toMatchObject({ call: false, side: 'sell', K: 740, qty: 2, premium: 4.1 });
    expect(res.summary).toMatchObject({ positions: 2, calls: 1, puts: 1, long: 1, short: 1, minDays: 96 });
  });

  test('comma CSV with quoted fields containing delimiters', () => {
    const t = parseCsvText('type,strike,dte,qty,notes\ncall,760,30,1,"hedge, rolled ""twice"""\r\n');
    expect(t[1]).toEqual(['call', '760', '30', '1', 'hedge, rolled "twice"']);
    expect(importPortfolio(t, { market, today }).legs).toHaveLength(1);
  });

  test('side inferred from the type column or the sign of quantity', () => {
    const res = importPortfolio([['type', 'strike', 'days', 'qty'],
      ['Short Put', 740, 30, 1], ['call', 770, 30, -4], ['long call', 780, 30, 2]], { market, today });
    expect(res.legs.map(l => [l.call, l.side, l.qty])).toEqual(
      [[false, 'sell', 1], [true, 'sell', 4], [true, 'buy', 2]]);
    expect(res.warnings.some(w => w.includes('model prices'))).toBe(true);
    expect(res.legs[0].premium).toBeCloseTo(bsPrice(false, market.S, 740, 30 / 365, market.sigma, market.r), 12);
  });

  test('headerless rows use type, strike, days, qty, premium order', () => {
    const res = importPortfolio(parseCsvText('call,760,30,2,5.5\nput,740,45,-1,\n'), { market, today });
    expect(res.headerless).toBe(true);
    expect(res.legs.map(l => [l.call, l.K, Math.round(l.T * 365), l.side, l.qty])).toEqual(
      [[true, 760, 30, 'buy', 2], [false, 740, 45, 'sell', 1]]);
    expect(res.legs[0].premium).toBe(5.5);
  });

  test('row-level errors, missing columns and empty files are reported', () => {
    const bad = importPortfolio([['type', 'strike', 'days', 'qty', 'side'],
      ['straddle', 760, 30, 1, 'buy'], ['call', -5, 30, 1, 'buy'], ['call', 760, 0, 1, 'buy'],
      ['put', 740, 30, 0, 'buy'], ['put', 740, 30, 1, 'maybe'], ['put', 740, 30, 1, 'buy']],
      { market, today });
    expect(bad.rows.map(r => r.errors.length > 0)).toEqual([true, true, true, true, true, false]);
    expect(bad.rows[0].errors[0]).toContain('not call or put');
    expect(bad.rows[1].errors[0]).toContain('strike');
    expect(bad.rows[2].errors[0]).toContain('expired');
    expect(bad.rows[3].errors[0]).toContain('quantity');
    expect(bad.rows[4].errors[0]).toContain('side');
    expect(bad.legs).toHaveLength(1);

    const missing = importPortfolio([['type', 'qty'], ['call', 1]], { market, today });
    expect(missing.errors[0]).toMatch(/Missing required columns: strike, days/);
    expect(importPortfolio([], { market, today }).errors[0]).toContain('no rows');
    expect(importPortfolio([['', ''], ['#comment']], { market, today }).errors[0]).toContain('no rows');
  });

  test('more than 8 positions are trimmed with a warning', () => {
    const rows: unknown[][] = [['type', 'strike', 'days', 'qty']];
    for (let i = 0; i < 11; i++) rows.push(['call', 700 + 10 * i, 30, 1]);
    const res = importPortfolio(rows, { market, today });
    expect(res.legs).toHaveLength(8);
    expect(res.warnings.some(w => w.includes('11 valid positions'))).toBe(true);
  });

  test('bundled sample CSV imports cleanly with mixed expiries', () => {
    const res = importPortfolio(parseCsvText(SAMPLE_CSV), { market, today, instrument: 'SPY' });
    expect(res.errors).toEqual([]);
    expect(res.legs).toHaveLength(SAMPLE_ROWS.length - 1);
    expect(new Set(res.legs.map(l => l.T)).size).toBe(2);
  });

  for (const bookType of ['xlsx', 'biff8'] as const) {
    test(`${bookType === 'xlsx' ? 'XLSX' : 'XLS'} workbook with real dates and serials round-trips`, async () => {
      const ws = XLSX.utils.aoa_to_sheet([
        ['Underlying', 'C/P', 'Buy/Sell', 'Strike', 'Expiry', 'Quantity', 'Avg Price'],
        ['SPY', 'C', 'Buy', 760, new Date(2026, 11, 18), 5, 11.25],
        ['SPY', 'P', 'Sell', 740, '2026-12-18', 5, 9.8],
      ]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Positions');
      const buf = XLSX.write(wb, { bookType, type: 'array' }) as ArrayBuffer;
      const table = await readSpreadsheet(buf);
      const res = importPortfolio(table, { market, today, instrument: 'SPY' });
      expect(res.errors).toEqual([]);
      expect(res.legs.map(l => [l.call, l.side, l.K, Math.round(l.T * 365), l.qty, l.premium])).toEqual(
        [[true, 'buy', 760, 96, 5, 11.25], [false, 'sell', 740, 96, 5, 9.8]]);
    });
  }
});
