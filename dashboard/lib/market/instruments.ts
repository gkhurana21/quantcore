// Underlyings and the canonical engine contract.
//
// Snapshot prices are indicative (labelled as such in the UI). Dividend yield
// defaults to 0 so the default SPY contract matches the engine's canonical
// subscription and the original Playwright reference values.

export interface Instrument {
  sym: string;
  name: string;
  spot: number;
  vol: number;
  q: number;
  step: number;   // spot slider step
  kstep: number;  // listed strike spacing used by presets
  live?: boolean;   // price from the live data proxy
  custom?: boolean; // any ticker with a price entered by the user
}

export const INSTRUMENTS: Instrument[] = [
  { sym: 'SPY',  name: 'SPDR S&P 500 ETF',     spot: 756.48, vol: 0.138, q: 0, step: 0.5,  kstep: 5 },
  { sym: 'QQQ',  name: 'Invesco Nasdaq-100 ETF', spot: 515.20, vol: 0.165, q: 0, step: 0.5,  kstep: 5 },
  { sym: 'AAPL', name: 'Apple Inc.',            spot: 227.60, vol: 0.225, q: 0, step: 0.25, kstep: 2.5 },
  { sym: 'NVDA', name: 'NVIDIA Corp.',          spot: 142.35, vol: 0.380, q: 0, step: 0.25, kstep: 2.5 },
  { sym: 'TSLA', name: 'Tesla Inc.',            spot: 251.80, vol: 0.450, q: 0, step: 0.5,  kstep: 5 },
];

/** The contract the C++ engine subscribes to — must match server defaults and the Playwright suite. */
export const CANONICAL = {
  sym: 'SPY', S: 756.48, K: 755, r: 0.045, sigma: 0.138, T: 0.129, qty: 10,
} as const;

export const ENGINE_SUBSCRIPTION = {
  S: CANONICAL.S, K: CANONICAL.K, r: CANONICAL.r, sigma: CANONICAL.sigma, T: CANONICAL.T,
  call: true, position: CANONICAL.qty,
};

export const findInstrument = (sym: string): Instrument | undefined =>
  INSTRUMENTS.find(i => i.sym === sym);

/** Any ticker priced from a user-entered spot (no data feed); volatility starts at 30%. */
export function mkCustomInstrument(sym: string, spot: number, vol = 0.3): Instrument {
  return { ...mkLiveInstrument(sym, sym, spot, vol), name: `${sym} · manual price`, live: false, custom: true };
}

/** Instrument for a live-quoted ticker: strike spacing and slider step follow price magnitude. */
export function mkLiveInstrument(sym: string, name: string, spot: number, vol: number): Instrument {
  const kstep = spot >= 200 ? 5 : spot >= 100 ? 2.5 : spot >= 40 ? 1 : spot >= 10 ? 0.5 : 0.25;
  const step = spot >= 400 ? 0.5 : spot >= 100 ? 0.25 : spot >= 20 ? 0.1 : 0.01;
  return { sym, name, spot, vol, q: 0, step, kstep, live: true };
}
