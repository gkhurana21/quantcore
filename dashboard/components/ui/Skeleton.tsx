import type { CSSProperties } from 'react';

/** Bar heights for the histogram placeholder: a rough bell, so the block already has the shape of what will replace it. */
const BELL = [8, 14, 24, 38, 56, 72, 84, 90, 84, 70, 52, 36, 24, 15, 9, 5];

/**
 * A shimmering placeholder in the shape of the thing that is loading. It stands in for bare
 * "simulating…" text and empty boxes; the label is read to screen readers and `data-skeleton` marks it
 * for the test harness. `prefers-reduced-motion` stops the shimmer (global rule), leaving a still block.
 */
export function Skeleton({ shape = 'chart', label, height, lines = 4 }: {
  shape?: 'chart' | 'bars' | 'lines' | 'inline'; label: string; height?: number; lines?: number;
}) {
  if (shape === 'inline') {
    return <span className="sk sk-inline" aria-hidden="true" title={label} data-skeleton="" style={{ display: 'inline-block', width: '4.5em', height: '0.9em', verticalAlign: '-0.1em' }} />;
  }
  return (
    <div role="status" aria-label={label} data-skeleton="" style={{ display: 'grid', gap: 10, width: '100%' }}>
      {shape === 'bars' ? (
        <div aria-hidden="true" style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: height ?? 190, padding: '0 4px' }}>
          {BELL.map((h, i) => (
            <span key={i} className="sk" style={{ flex: 1, height: `${h}%`, borderRadius: '3px 3px 0 0', animationDelay: `${i * 70}ms` } as CSSProperties} />
          ))}
        </div>
      ) : shape === 'lines' ? (
        <div aria-hidden="true" style={{ display: 'grid', gap: 9 }}>
          {Array.from({ length: lines }, (_, i) => (
            <span key={i} className="sk sk-line" style={{ width: `${100 - ((i * 17) % 38)}%`, animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : (
        <span aria-hidden="true" className="sk sk-chart" style={height ? { aspectRatio: 'auto', height } : undefined} />
      )}
      <span className="sr-only">{label}</span>
    </div>
  );
}
