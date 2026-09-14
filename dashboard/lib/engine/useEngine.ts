'use client';

// Client for the local C++ engine (server/ws_server.py).
//
// The engine only runs on the developer's machine, so a connection is attempted
// only when the page itself is served from localhost. A hosted build reports
// "Offline" immediately and never probes a visitor's network. Nothing here
// fabricates engine output: every number exposed as engine-sourced arrived over
// the socket.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ENGINE_SUBSCRIPTION } from '../market/instruments';
import type { Greeks, Leg, Market } from '../quant/types';
import { CONTRACT_MULT, signedQty } from '../quant/types';
import { hasVolSurface, legSigma } from '../quant/volSurface';

export const ENGINE_URL = 'ws://localhost:8765/ws';
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/;
const RETRY_DELAYS = [2000, 5000];
const RTT_WINDOW = 60;

export type EngineStatus = 'connecting' | 'connected' | 'offline';
export type OfflineReason = 'hosted' | 'unreachable' | 'closed' | null;

export interface EngineQuote extends Greeks {
  pnl: number;
  calcUs: number | null;
  key: string;           // market the quote was computed for
}

export interface EngineInfo {
  protocol: number; metal: boolean; device: string; cpuThreads: number;
  dividends: boolean;   // protocol ≥ 3: every pricing message accepts q
}

export interface EnginePortfolioResult { legs: Greeks[]; calcUs: number; rttMs: number; }

export interface EngineMcRequest {
  call: boolean; S: number; K: number; r: number; sigma: number; T: number; paths: number; seed: number; q: number;
}

export interface EngineMcResult {
  price: number; stdError: number; paths: number; ms: number;
  backend: string; device: string; rttMs: number;
}

/** Protocol v6 local-volatility run: time steps per path and, when extrapolating, the fine grid's bias estimate. */
export interface EngineLocalVolResult extends EngineMcResult { steps: number; fineBias: number | null; }

export interface EngineStats {
  sent: number;
  received: number;
  lastCalcUs: number | null;
  rtt: number[];          // recent round-trip times, ms
}

export const marketKey = (S: number, sigma: number, r: number, q = 0): string => `${S}|${sigma}|${r}|${q}`;
export const CANONICAL_KEY = marketKey(ENGINE_SUBSCRIPTION.S, ENGINE_SUBSCRIPTION.sigma, ENGINE_SUBSCRIPTION.r);

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  t0: number;
  timer: ReturnType<typeof setTimeout>;
}

const EMPTY_STATS: EngineStats = { sent: 0, received: 0, lastCalcUs: null, rtt: [] };

export interface Engine {
  url: string;
  status: EngineStatus;
  reason: OfflineReason;
  quote: EngineQuote | null;
  info: EngineInfo | null;
  stats: EngineStats;
  sendUpdate: (m: Pick<Market, 'S' | 'sigma' | 'r' | 'q'>) => boolean;
  pricePortfolio: (legs: Leg[], m: Market) => Promise<EnginePortfolioResult>;
  runMc: (req: EngineMcRequest) => Promise<EngineMcResult>;
  /** Protocol v5: the whole portfolio by Monte Carlo on the CPU, each leg at its smile volatility. */
  runPortfolioMc: (legs: Leg[], m: Market, paths: number, seed: number, antithetic: boolean) => Promise<EngineMcResult>;
  /** Protocol v6: the portfolio under the market's Dupire local volatility, multithreaded on the CPU. */
  runLocalVolMc: (legs: Leg[], m: Market, paths: number, seed: number, stepsPerYear: number,
                  extrapolate: boolean) => Promise<EngineLocalVolResult>;
  reconnect: () => void;
}

export function useEngine(): Engine {
  const [status, setStatus] = useState<EngineStatus>('connecting');
  const [reason, setReason] = useState<OfflineReason>(null);
  const [quote, setQuote] = useState<EngineQuote | null>(null);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [stats, setStats] = useState<EngineStats>(EMPTY_STATS);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<number, Pending>());
  const updateKeysRef = useRef(new Map<number, string>());
  const seqRef = useRef(1);
  const lastTnsRef = useRef(0);
  const countersRef = useRef({ sent: 0, received: 0, lastCalcUs: null as number | null, rtt: [] as number[] });
  const connectRef = useRef<() => void>(() => {});

  const publishStats = useCallback(() => {
    const c = countersRef.current;
    setStats({ sent: c.sent, received: c.received, lastCalcUs: c.lastCalcUs, rtt: c.rtt.slice() });
  }, []);

  const rawSend = useCallback((msg: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    countersRef.current.sent++;
    return true;
  }, []);

  const stamp = () => {
    const t = Math.max(Math.round(performance.now() * 1e6), lastTnsRef.current + 1);
    lastTnsRef.current = t;
    return t;
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!LOCAL_HOST.test(window.location.hostname)) {
      setStatus('offline');
      setReason('hosted');
      return;
    }

    let disposed = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let statsTimer: ReturnType<typeof setInterval> | undefined;
    const counters = countersRef.current;
    const pending = pendingRef.current;
    const updateKeys = updateKeysRef.current;

    const pushRtt = (ms: number) => {
      if (!(ms >= 0) || ms > 60_000) return;
      counters.rtt.push(ms);
      if (counters.rtt.length > RTT_WINDOW) counters.rtt.shift();
    };

    const failPending = (why: string) => {
      pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error(why)); });
      pending.clear();
      updateKeys.clear();
    };

    const onMessage = (ev: MessageEvent) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      counters.received++;
      const n = (k: string) => Number(msg[k]);
      switch (msg.type) {
        case 'subscribed':
          setQuote({ price: n('price'), delta: n('delta'), gamma: n('gamma'), theta: n('theta'),
                     vega: n('vega'), pnl: 0, calcUs: null, key: CANONICAL_KEY });
          break;
        case 'result': {
          const t = n('t_ns');
          const key = updateKeys.get(t);
          updateKeys.delete(t);
          if (t) pushRtt(performance.now() - t / 1e6);
          counters.lastCalcUs = n('calc_us');
          if (key) {
            setQuote({ price: n('price'), delta: n('delta'), gamma: n('gamma'), theta: n('theta'),
                       vega: n('vega'), pnl: n('pnl'), calcUs: n('calc_us'), key });
          }
          break;
        }
        case 'pong':
          pushRtt(performance.now() - n('t_ns') / 1e6);
          break;
        case 'info':
          setInfo({ protocol: n('protocol'), metal: !!msg.metal, device: String(msg.device ?? ''),
                    cpuThreads: n('cpu_threads') || 0, dividends: msg.dividends === true });
          break;
        case 'portfolio_result':
        case 'mc_result':
        case 'mc_portfolio_result':
        case 'mc_local_vol_result':
        case 'error': {
          const id = n('id');
          const p = pending.get(id);
          if (!p) break;
          pending.delete(id);
          clearTimeout(p.timer);
          const rttMs = performance.now() - p.t0;
          pushRtt(rttMs);
          if (msg.type === 'error') {
            p.reject(new Error(String(msg.msg ?? 'engine error')));
          } else if (msg.type === 'portfolio_result') {
            counters.lastCalcUs = n('calc_us');
            p.resolve({ legs: msg.legs as Greeks[], calcUs: n('calc_us'), rttMs });
          } else {
            p.resolve({ price: n('price'), stdError: n('std_error'), paths: n('paths'), ms: n('ms'),
                        backend: String(msg.backend), device: String(msg.device ?? ''), rttMs,
                        ...(msg.type === 'mc_local_vol_result'
                          ? { steps: n('steps'), fineBias: msg.fine_bias == null ? null : n('fine_bias') } : {}) });
          }
          break;
        }
      }
    };

    const connect = () => {
      if (disposed || wsRef.current) return;
      clearTimeout(retryTimer);
      setStatus('connecting');
      let ws: WebSocket;
      try {
        ws = new WebSocket(ENGINE_URL);
      } catch {
        setStatus('offline');
        setReason('unreachable');
        return;
      }
      wsRef.current = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        retries = 0;
        setReason(null);
        setStatus('connected');
        rawSend({ type: 'subscribe', option: ENGINE_SUBSCRIPTION });
        rawSend({ type: 'info' });
        pingTimer = setInterval(() => rawSend({ type: 'ping', t_ns: stamp() }), 2000);
        statsTimer = setInterval(publishStats, 1000);
      };
      ws.onmessage = onMessage;
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        clearInterval(pingTimer);
        clearInterval(statsTimer);
        failPending('engine disconnected');
        if (disposed) return;
        setQuote(null);
        setStatus('offline');
        setReason(opened ? 'closed' : 'unreachable');
        publishStats();
        if (retries < RETRY_DELAYS.length) retryTimer = setTimeout(connect, RETRY_DELAYS[retries++]);
      };
    };

    connectRef.current = () => { retries = 0; connect(); };
    connect();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      clearInterval(statsTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onmessage = null;
        ws.onclose = null;
        // closing a socket that is still connecting logs a browser warning — close once open instead
        if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
        else ws.close();
      }
      failPending('engine hook unmounted');
    };
  }, [publishStats, rawSend]);

  const sendUpdate = useCallback((m: Pick<Market, 'S' | 'sigma' | 'r' | 'q'>): boolean => {
    const t_ns = stamp();
    if (!rawSend({ type: 'update', S: m.S, sigma: m.sigma, r: m.r, q: m.q, t_ns })) return false;
    const keys = updateKeysRef.current;
    keys.set(t_ns, marketKey(m.S, m.sigma, m.r, m.q));
    if (keys.size > 256) keys.delete(keys.keys().next().value as number);
    return true;
  }, [rawSend]);

  const request = useCallback(<T,>(msg: Record<string, unknown>, timeoutMs: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = seqRef.current++;
      if (!rawSend({ ...msg, id })) { reject(new Error('engine offline')); return; }
      const timer = setTimeout(() => {
        pendingRef.current.delete(id);
        reject(new Error('engine timed out'));
      }, timeoutMs);
      pendingRef.current.set(id, { resolve: resolve as (v: unknown) => void, reject, t0: performance.now(), timer });
    }), [rawSend]);

  const pricePortfolio = useCallback((legs: Leg[], m: Market) =>
    request<EnginePortfolioResult>({
      type: 'portfolio', S: m.S, sigma: m.sigma, r: m.r, q: m.q,
      // protocol v4: with a smile or term structure each leg carries its own volatility; flat markets send the v3 message unchanged
      legs: legs.map(l => ({ call: l.call, K: l.K, T: l.T, ...(hasVolSurface(m) ? { sigma: legSigma(m, l.K, l.T) } : {}) })),
    }, 5000), [request]);

  const runMc = useCallback((req: EngineMcRequest) =>
    request<EngineMcResult>({ type: 'mc', ...req }, 120_000), [request]);

  const runPortfolioMc = useCallback((legs: Leg[], m: Market, paths: number, seed: number, antithetic: boolean) =>
    request<EngineMcResult>({
      type: 'mc_portfolio', S: m.S, r: m.r, q: m.q, paths, seed, antithetic,
      legs: legs.map(l => ({ call: l.call, K: l.K, T: l.T, sigma: legSigma(m, l.K, l.T), weight: signedQty(l) * CONTRACT_MULT })),
    }, 120_000), [request]);

  const runLocalVolMc = useCallback((legs: Leg[], m: Market, paths: number, seed: number, stepsPerYear: number,
                                     extrapolate: boolean) =>
    request<EngineLocalVolResult>({
      type: 'mc_local_vol', paths, seed, steps_per_year: stepsPerYear, extrapolate,
      // the market as the browser models see it: the server builds the same SSVI surface from it
      market: { S: m.S, sigma: m.sigma, r: m.r, q: m.q, ...(m.smile ? { smile: m.smile } : {}),
                ...(m.smileSpot != null ? { smileSpot: m.smileSpot } : {}), ...(m.term ? { term: m.term } : {}) },
      legs: legs.map(l => ({ call: l.call, K: l.K, T: l.T, weight: signedQty(l) * CONTRACT_MULT })),
    }, 120_000), [request]);

  const reconnect = useCallback(() => connectRef.current(), []);

  return { url: ENGINE_URL, status, reason, quote, info, stats, sendUpdate, pricePortfolio, runMc, runPortfolioMc,
           runLocalVolMc, reconnect };
}
