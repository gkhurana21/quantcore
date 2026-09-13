'use client';

import { useEffect, useRef, useState } from 'react';
import { runTask } from './tasks';
import type { TaskKind, TaskMap } from './tasks';

type Req<K extends TaskKind> = TaskMap[K][0];
type Res<K extends TaskKind> = TaskMap[K][1];

interface Job<K extends TaskKind> { id: number; key: string; req: Req<K>; }

type Done<K extends TaskKind> = (id: number, key: string, result: Res<K> | null, error: string | null) => void;

/**
 * One worker per consumer. At most one job runs at a time and only the newest
 * waiting request is kept, so dragging a slider never builds a backlog.
 * Falls back to running on the main thread if a worker cannot be created.
 */
class TaskRunner<K extends TaskKind> {
  private worker: Worker | null = null;
  private current: Job<K> | null = null;
  private queued: Job<K> | null = null;
  private seq = 0;
  mode: 'worker' | 'main-thread' = 'main-thread';

  constructor(private readonly kind: K, private readonly done: Done<K>) {}

  start() {
    if (typeof Worker === 'undefined') return;
    try {
      const w = new Worker(new URL('../../workers/compute.worker.ts', import.meta.url));
      w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: Res<K>; error?: string }>) => {
        if (!this.current || e.data.id !== this.current.id) return;
        this.finish(e.data.ok ? e.data.result ?? null : null, e.data.ok ? null : e.data.error ?? 'failed');
      };
      w.onerror = (e) => { e.preventDefault(); this.degrade(); };
      this.worker = w;
      this.mode = 'worker';
    } catch {
      this.worker = null;
    }
  }

  submit(key: string, req: Req<K>) {
    const job = { id: ++this.seq, key, req };
    if (this.current) this.queued = job;
    else this.run(job);
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    this.current = this.queued = null;
  }

  private run(job: Job<K>) {
    this.current = job;
    if (this.worker) {
      this.worker.postMessage({ id: job.id, kind: this.kind, req: job.req });
      return;
    }
    setTimeout(() => {
      if (this.current !== job) return;
      try { this.finish(runTask(this.kind, job.req), null); }
      catch (err) { this.finish(null, err instanceof Error ? err.message : String(err)); }
    }, 0);
  }

  private finish(result: Res<K> | null, error: string | null) {
    const job = this.current;
    this.current = null;
    if (job) this.done(job.id, job.key, result, error);
    const next = this.queued;
    this.queued = null;
    if (next) this.run(next);
  }

  private degrade() {
    this.worker?.terminate();
    this.worker = null;
    this.mode = 'main-thread';
    const job = this.current;
    this.current = null;
    if (job) this.run(job);
  }
}

export interface WorkerTaskState<R> {
  result: R | null;
  resultKey: string | null;   // inputs the shown result belongs to
  running: boolean;           // true while the shown result is stale
  error: string | null;
  mode: 'worker' | 'main-thread';
}

/** Run a compute task whenever `key` changes (debounced); newer results replace older ones. */
export function useWorkerTask<K extends TaskKind>(kind: K, req: Req<K> | null, key: string,
                                                  debounceMs = 80): WorkerTaskState<Res<K>> {
  const [out, setOut] = useState<{ id: number; key: string | null; result: Res<K> | null; error: string | null }>(
    { id: 0, key: null, result: null, error: null });
  const [mode, setMode] = useState<'worker' | 'main-thread'>('main-thread');
  const runnerRef = useRef<TaskRunner<K> | null>(null);
  const reqRef = useRef(req);
  reqRef.current = req;

  useEffect(() => {
    const runner = new TaskRunner(kind, (id, key, result, error) =>
      setOut(prev => (id > prev.id ? { id, key, result: result ?? prev.result, error } : prev)));
    runner.start();
    runnerRef.current = runner;
    setMode(runner.mode);
    return () => { runner.stop(); runnerRef.current = null; setOut(o => ({ ...o, id: 0 })); };
  }, [kind]);

  // A null request pauses the task (e.g. a hidden tab); re-enabling resubmits the current key.
  const enabled = req != null;
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => {
      if (runnerRef.current && reqRef.current) runnerRef.current.submit(key, reqRef.current);
    }, debounceMs);
    return () => clearTimeout(t);
  }, [key, debounceMs, enabled]);

  return { result: out.result, resultKey: out.key, running: !!req && out.key !== key, error: out.error, mode };
}
