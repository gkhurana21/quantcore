import type { Leg, Market } from '../quant/types';

const strike = (k: number) => (Number.isInteger(k) ? String(k) : k.toFixed(2));

/** "Buy 10 C 755 · 47d" */
export const legLabel = (l: Leg): string =>
  `${l.side === 'buy' ? 'Buy' : 'Sell'} ${l.qty} ${l.call ? 'C' : 'P'} ${strike(l.K)} · ${Math.round(l.T * 365)}d`;

const termKeyOf = (m: Market): string =>
  !m.term ? 'flat'
    : m.term.kind === 'curve' ? `curve:${m.term.ratio},${m.term.halfLife}`
    : `fitted:${m.term.T.join(',')};${m.term.w.join(',')}`;

/** Identity of every market input that changes a model price, smile and term structure included — pairs with legsKeyOf. */
export const marketKeyOf = (m: Market): string =>
  `${m.S}|${m.sigma}|${m.r}|${m.q}|${m.smile ? `${m.smile.rho},${m.smile.eta},${m.smile.gamma}` : 'flat'}|${termKeyOf(m)}`;

/** Identity of the priced terms of a portfolio (premium excluded) — used as a cache / request key. */
export const legsKeyOf = (legs: Leg[]): string =>
  legs.map(l => `${l.call ? 'C' : 'P'}${l.side === 'buy' ? '+' : '-'}${l.qty}@${l.K}/${l.T}`).join(',');
