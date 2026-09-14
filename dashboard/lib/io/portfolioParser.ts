// Tolerant, client-side portfolio import. Accepts tables from CSV text or a
// spreadsheet (string / number / Date cells) and maps them onto option legs with
// row-level validation. Nothing here touches the network.

import { bsPrice } from '../quant/blackScholes';
import { legSigma } from '../quant/volSurface';
import type { Leg, Market, Side } from '../quant/types';
import { CONTRACT_MULT as M } from '../quant/types';

export type Field = 'type' | 'side' | 'strike' | 'days' | 'expiry' | 'years' | 'qty' | 'premium' | 'symbol';

const ALIASES: Record<Field, string[]> = {
  type:    ['type', 'optiontype', 'optype', 'cp', 'callput', 'putcall', 'right', 'kind', 'option',
            'contracttype', 'pc', 'instrumenttype'],
  side:    ['side', 'action', 'direction', 'buysell', 'bs', 'longshort', 'positionside', 'transaction',
            'tradeside', 'buyorsell'],
  strike:  ['strike', 'k', 'strikeprice', 'exerciseprice', 'strk'],
  days:    ['days', 'dte', 'daystoexpiry', 'daystoexpiration', 'daysleft', 'tenordays', 'daystomaturity'],
  expiry:  ['expiry', 'expiration', 'expirationdate', 'expirydate', 'expdate', 'exp', 'maturity',
            'maturitydate'],
  years:   ['years', 't', 'tyears', 'yearstoexpiry', 'timetoexpiry', 'tenor'],
  qty:     ['qty', 'quantity', 'contracts', 'position', 'size', 'lots', 'amount', 'units', 'count', 'pos'],
  premium: ['premium', 'price', 'entry', 'entryprice', 'cost', 'fill', 'fillprice', 'avgprice',
            'averageprice', 'tradeprice', 'mark', 'openprice', 'costbasis'],
  symbol:  ['symbol', 'underlying', 'ticker', 'root', 'underlier', 'asset'],
};

const LOOKUP = new Map<string, Field>();
for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) {
  for (const n of names) LOOKUP.set(n, field);
}

export const COLUMN_DOCS: { column: string; required: string; aliases: string }[] = [
  { column: 'type',    required: 'yes', aliases: 'option_type, cp, right, call/put — values: call, put, C, P' },
  { column: 'strike',  required: 'yes', aliases: 'k, strike_price, exercise_price' },
  { column: 'days',    required: 'one of', aliases: 'dte, days_to_expiry — or expiry / expiration (date), or years' },
  { column: 'qty',     required: 'yes', aliases: 'quantity, contracts, position, size — negative = short' },
  { column: 'side',    required: 'no',  aliases: 'action, buy_sell, long_short — buy/long, sell/short' },
  { column: 'premium', required: 'no',  aliases: 'price, entry, fill_price, cost — per share; blank = model price' },
  { column: 'symbol',  required: 'no',  aliases: 'underlying, ticker — informational' },
];

const normalizeHeader = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cellText = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim();

// ── CSV ─────────────────────────────────────────────────────────────────────

function sniffDelimiter(line: string): string {
  let best = ',', bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0, quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/** RFC 4180-style CSV parsing: quoted fields, escaped quotes, CRLF, BOM, delimiter sniffing. */
export function parseCsvText(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/).find(l => l.trim()) ?? '';
  const delim = sniffDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ── cell parsers ────────────────────────────────────────────────────────────

/** "$1,234.50" → 1234.5, "12,50" / "1.234,50" (decimal comma) → 12.5 / 1234.5, "(5)" → −5, "12%" → 12. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[$€£¥\s]/g, '').replace(/%$/, '');
  // A comma followed by 1–2 digits cannot be a thousands separator: treat it as a
  // decimal comma (European exports), with any dots before it as thousands.
  if (/^[-+]?[\d.]*\d,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

export function parseSide(v: unknown): Side | undefined {
  const s = cellText(v).toLowerCase();
  if (!s) return undefined;
  if (/^(b|l|\+|buy|bought|long|bto|buytoopen)$/.test(s) || /(^|[^a-z])(buy|bought|long)([^a-z]|$)/.test(s)) return 'buy';
  if (/^(s|w|-|sell|sold|short|sto|selltoopen|write|written)$/.test(s) ||
      /(^|[^a-z])(sell|sold|short|write|written)([^a-z]|$)/.test(s)) return 'sell';
  return undefined;
}

function parseKind(v: unknown): { call?: boolean; side?: Side } {
  const s = cellText(v).toLowerCase();
  if (!s) return {};
  const out: { call?: boolean; side?: Side } = {};
  if (s === 'c' || /(^|[^a-z])(call|calls|ce)([^a-z]|$)/.test(s)) out.call = true;
  else if (s === 'p' || /(^|[^a-z])(put|puts|pe)([^a-z]|$)/.test(s)) out.call = false;
  if (s.length > 1) {
    const side = parseSide(s);
    if (side) out.side = side;
  }
  return out;
}

const DAY_MS = 86_400_000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function validYmd(y: number, mo: number, d: number): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  return new Date(t).getUTCDate() === d ? t : null;
}

/** Days from `today` to an expiry given as a Date, ISO/US date string or Excel serial. */
export function parseExpiryDays(v: unknown, today: Date): number | null {
  let t: number | null = null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    t = Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  } else if (typeof v === 'number' && v > 20_000 && v < 80_000) {
    t = EXCEL_EPOCH + Math.round(v) * DAY_MS;
  } else if (typeof v === 'string') {
    const s = v.trim();
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
      t = validYmd(+m[1], +m[2], +m[3]);
    } else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) {
      const y = +m[3] < 100 ? +m[3] + 2000 : +m[3];
      t = validYmd(y, +m[1], +m[2]);                        // US month/day/year
    } else if (/[a-z]/i.test(s)) {
      const p = Date.parse(s);
      if (!isNaN(p)) { const d = new Date(p); t = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
    } else {
      const n = parseNumber(s);
      if (n != null && n > 20_000 && n < 80_000) t = EXCEL_EPOCH + Math.round(n) * DAY_MS;
    }
  }
  if (t == null || isNaN(t)) return null;
  const t0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((t - t0) / DAY_MS);
}

// ── import ──────────────────────────────────────────────────────────────────

export interface ImportedRow {
  line: number;              // 1-based line in the source file
  cells: string[];
  leg?: Leg;
  errors: string[];
  warnings: string[];
}

export interface ImportSummary {
  positions: number; calls: number; puts: number; long: number; short: number;
  netPremium: number; minDays: number; maxDays: number;
}

export interface PortfolioImport {
  rows: ImportedRow[];
  legs: Leg[];
  errors: string[];
  warnings: string[];
  mapping: Partial<Record<Field, string>>;
  headerless: boolean;
  summary: ImportSummary | null;
}

export interface ImportOptions {
  market: Market;
  instrument?: string;
  today?: Date;
  maxLegs?: number;
}

export function importPortfolio(table: unknown[][], opts: ImportOptions): PortfolioImport {
  const today = opts.today ?? new Date();
  const maxLegs = opts.maxLegs ?? 8;
  const { S, r, q } = opts.market;
  const result: PortfolioImport = {
    rows: [], legs: [], errors: [], warnings: [], mapping: {}, headerless: false, summary: null,
  };

  const lines = table
    .map((cells, i) => ({ line: i + 1, cells: Array.isArray(cells) ? cells : [] }))
    .filter(({ cells }) => cells.some(c => cellText(c) !== '') && !cellText(cells[0]).startsWith('#'));
  if (!lines.length) { result.errors.push('The file has no rows.'); return result; }

  // header detection: a header row names at least two known columns
  const first = lines[0].cells;
  const headerHits = first.filter(c => LOOKUP.has(normalizeHeader(c))).length;
  const firstHasNumber = first.some(c => parseNumber(c) != null);
  const col: Partial<Record<Field, number>> = {};
  let body = lines;
  if (headerHits >= 2 || (headerHits >= 1 && !firstHasNumber)) {
    first.forEach((c, i) => {
      const f = LOOKUP.get(normalizeHeader(c));
      if (f && col[f] == null) { col[f] = i; result.mapping[f] = cellText(c); }
    });
    body = lines.slice(1);
  } else {
    result.headerless = true;
    (['type', 'strike', 'days', 'qty', 'premium'] as Field[]).forEach((f, i) => {
      col[f] = i; result.mapping[f] = `column ${i + 1}`;
    });
  }

  const missing: string[] = [];
  if (col.type == null) missing.push('type (call/put)');
  if (col.strike == null) missing.push('strike');
  if (col.qty == null) missing.push('qty');
  if (col.days == null && col.expiry == null && col.years == null) missing.push('days, DTE or expiry date');
  if (missing.length) {
    result.errors.push(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
    return result;
  }
  if (!body.length) { result.errors.push('The file has a header but no positions.'); return result; }

  const symbols = new Set<string>();
  let premiumFilled = 0;

  for (const { line, cells } of body) {
    const get = (f: Field) => (col[f] != null ? cells[col[f]!] : undefined);
    const errors: string[] = [], warnings: string[] = [];

    const kind = parseKind(get('type'));
    if (kind.call == null) errors.push(`type “${cellText(get('type')) || 'blank'}” is not call or put`);

    const K = parseNumber(get('strike'));
    if (K == null || K <= 0) errors.push('strike must be a positive number');

    let days: number | null = null;
    if (col.days != null && cellText(get('days'))) {
      const d = parseNumber(get('days'));
      if (d != null) days = Math.round(d);
    }
    if (days == null && col.expiry != null && cellText(get('expiry'))) days = parseExpiryDays(get('expiry'), today);
    if (days == null && col.years != null && cellText(get('years'))) {
      const y = parseNumber(get('years'));
      if (y != null) days = Math.round(y * 365);
    }
    if (days == null) errors.push('no readable expiry (days, DTE or expiry date)');
    else if (days < 1) errors.push('option has already expired');
    else if (days > 1095) errors.push('expiry is more than 3 years out');

    const rawQty = parseNumber(get('qty'));
    if (rawQty == null || rawQty === 0) errors.push('quantity must be a non-zero number');
    else if (Math.abs(rawQty) > 100_000) errors.push('quantity is unrealistically large');

    let side: Side | undefined;
    if (col.side != null && cellText(get('side'))) {
      side = parseSide(get('side'));
      if (!side) errors.push(`side “${cellText(get('side'))}” is not buy or sell`);
    }
    side = side ?? kind.side ?? (rawQty != null && rawQty < 0 ? 'sell' : 'buy');

    let premium: number | null = null;
    if (col.premium != null && cellText(get('premium'))) {
      premium = parseNumber(get('premium'));
      if (premium == null) errors.push('premium is not a number');
      else if (premium < 0) errors.push('premium cannot be negative');
    }

    const sym = col.symbol != null ? cellText(get('symbol')).toUpperCase() : '';
    if (sym) symbols.add(sym);

    const row: ImportedRow = { line, cells: cells.map(cellText), errors, warnings };
    if (!errors.length) {
      const T = days! / 365;
      if (premium == null) { premium = bsPrice(kind.call!, S, K!, T, legSigma(opts.market, K!, T), r, q); premiumFilled++; }
      if (K! < 0.25 * S || K! > 4 * S) warnings.push(`strike ${K} is far from spot ${S.toFixed(2)}`);
      row.leg = { id: `imp-${line}`, call: kind.call!, side, qty: Math.abs(rawQty!), K: K!, T, premium };
    }
    result.rows.push(row);
  }

  const valid = result.rows.filter(r => r.leg).map(r => r.leg!);
  if (valid.length > maxLegs) {
    result.warnings.push(`${valid.length} valid positions found; the terminal models up to ${maxLegs} legs, so the first ${maxLegs} were kept.`);
  }
  result.legs = valid.slice(0, maxLegs);
  if (premiumFilled) {
    result.warnings.push(`Premium missing on ${premiumFilled} row${premiumFilled > 1 ? 's' : ''} — model prices used, so P&L starts at zero for those legs.`);
  }
  if (opts.instrument && [...symbols].some(s => s !== opts.instrument!.toUpperCase())) {
    result.warnings.push(`File lists ${[...symbols].join(', ')}; positions are priced on the selected underlying ${opts.instrument}.`);
  }
  const badRows = result.rows.filter(r => r.errors.length).length;
  if (badRows && !valid.length) result.errors.push('No valid positions — fix the highlighted rows and re-upload.');

  if (result.legs.length) {
    const ls = result.legs;
    const days = ls.map(l => Math.round(l.T * 365));
    result.summary = {
      positions: ls.length,
      calls: ls.filter(l => l.call).length,
      puts: ls.filter(l => !l.call).length,
      long: ls.filter(l => l.side === 'buy').length,
      short: ls.filter(l => l.side === 'sell').length,
      netPremium: ls.reduce((a, l) => a + (l.side === 'buy' ? 1 : -1) * l.qty * M * l.premium, 0),
      minDays: Math.min(...days),
      maxDays: Math.max(...days),
    };
  }
  return result;
}
