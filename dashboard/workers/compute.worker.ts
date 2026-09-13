// Web Worker entry point: runs pricing-lab, Monte Carlo and VaR tasks off the
// main thread so sliders and charts stay responsive during 200k-path runs.

import { runTask } from '../lib/compute/tasks';
import type { TaskKind, TaskMap } from '../lib/compute/tasks';

interface TaskMessage { id: number; kind: TaskKind; req: TaskMap[TaskKind][0]; }

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<TaskMessage>) => void) | null;
};

ctx.onmessage = (event) => {
  const { id, kind, req } = event.data;
  try {
    ctx.postMessage({ id, ok: true, result: runTask(kind, req as never) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
