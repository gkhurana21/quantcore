'use client';

// Live market data through the Go proxy (proxy/, Alpaca IEX + indicative options).
// Enabled only when the proxy is configured and answers its health probe; otherwise
// the terminal runs on labelled snapshot prices and makes no network requests.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import { findInstrument, mkLiveInstrument } from '@/lib/market/instruments';
import type { LiveChainOption } from '@/lib/market/marketData';
import { fetchChain, fetchExpirations, fetchQuote, probeProxy, proxyUrl } from '@/lib/market/marketData';
import type { TerminalAction } from './useTerminalState';

export type DataMode = 'checking' | 'live' | 'snapshot';

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export interface LiveData {
  mode: DataMode;
  feed: string | null;
  expirations: string[];      // the nearest expiries, for the legs' expiry picker
  allExpirations: string[];   // every listed expiry out to two years, for a surface fit
  expiry: string;
  chain: LiveChainOption[];
  chainMsg: string;
  atmIv: number;
  search: (raw: string) => Promise<string | null>;
  applyExpiry: (date: string) => void;
  usableIv: (iv?: number) => boolean;
}

export function useLiveData(sym: string, spot: number, dispatch: Dispatch<TerminalAction>): LiveData {
  const [mode, setMode] = useState<DataMode>('checking');
  const [feed, setFeed] = useState<string | null>(null);
  const [expirations, setExpirations] = useState<string[]>([]);
  const [allExpirations, setAllExpirations] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [chain, setChain] = useState<LiveChainOption[]>([]);
  const [chainMsg, setChainMsg] = useState('');
  const [atmIv, setAtmIv] = useState(0);
  const spotRef = useRef(spot);
  spotRef.current = spot;

  useEffect(() => {
    if (!proxyUrl()) { setMode('snapshot'); return; }
    let stale = false;
    probeProxy().then(ok => { if (!stale) setMode(ok ? 'live' : 'snapshot'); });
    return () => { stale = true; };
  }, []);

  useEffect(() => {
    setExpirations([]); setAllExpirations([]); setExpiry(''); setChain([]); setChainMsg(''); setAtmIv(0);
    if (mode !== 'live') return;
    let stale = false;
    fetchQuote(sym).then(q => {
      if (stale || !(q.last > 0)) return;
      const known = findInstrument(sym);
      setFeed(q.feed);
      dispatch({ type: 'liveQuote', instrument: mkLiveInstrument(sym, known?.name ?? sym, q.last, known?.vol ?? 0.3) });
    }).catch(() => { /* snapshot values stay in place */ });
    fetchExpirations(sym)
      .then(e => { if (!stale) { setExpirations(e.expirations.slice(0, 16)); setAllExpirations(e.expirations); } })
      .catch(() => { /* expiry picker stays hidden */ });
    return () => { stale = true; };
  }, [mode, sym, dispatch]);

  const search = useCallback(async (raw: string): Promise<string | null> => {
    const s = raw.trim().toUpperCase();
    if (!TICKER_RE.test(s)) return 'Enter a ticker symbol, e.g. AMD';
    try {
      const q = await fetchQuote(s);
      if (!(q.last > 0)) return `No price available for ${s}`;
      const known = findInstrument(s);
      dispatch({ type: 'instrument', instrument: mkLiveInstrument(s, known?.name ?? s, q.last, known?.vol ?? 0.3) });
      return null;
    } catch {
      return `No live quote for ${s} — unknown symbol or the data proxy is offline`;
    }
  }, [dispatch]);

  const applyExpiry = useCallback((date: string) => {
    setExpiry(date); setChain([]); setChainMsg(''); setAtmIv(0);
    if (!date) return;
    const d = Math.max(1, Math.round((Date.parse(`${date}T21:00:00Z`) - Date.now()) / 86_400_000));
    const T = d / 365;
    dispatch({ type: 'setExpiry', T });
    setChainMsg('Loading chain…');
    fetchChain(sym, date).then(c => {
      setChain(c.options);
      const S = spotRef.current;
      const nearestCall = (opts: LiveChainOption[]) => opts.filter(o => o.type === 'call')
        .sort((a, b) => Math.abs(a.strike - S) - Math.abs(b.strike - S))[0];
      const withIv = c.options.filter(o => o.iv && o.iv > 0);
      const ref = nearestCall(withIv)?.iv ?? 0;
      // deep ITM quotes imply absurd vols from a cent of noise — keep IVs near the ATM level
      const quoted = ref ? withIv.filter(o => o.iv! <= ref * 2.5 && o.iv! >= ref * 0.25) : withIv;
      setChainMsg(quoted.length
        ? `${c.options.length} contracts · ${quoted.length} with market IV · ${c.feed}`
        : `${c.options.length} contracts · no market IV on this expiry`);
      const atm = nearestCall(quoted);
      if (atm?.iv) {
        setAtmIv(atm.iv);
        dispatch({ type: 'market', patch: { sigma: Math.min(1.5, Math.max(0.01, atm.iv)) } });
        dispatch({ type: 'setExpiry', T });   // re-enter premiums at the market-implied vol
      }
    }).catch(() => setChainMsg('Chain unavailable — using model strikes'));
  }, [sym, dispatch]);

  const usableIv = useCallback((iv?: number) => {
    if (!iv || iv <= 0) return false;
    if (!atmIv) return true;
    return iv <= atmIv * 2.5 && iv >= atmIv * 0.25;
  }, [atmIv]);

  return { mode, feed, expirations, allExpirations, expiry, chain, chainMsg, atmIv, search, applyExpiry, usableIv };
}
