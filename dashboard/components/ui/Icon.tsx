// The terminal's icon set: one stroke weight, one grid, drawn inline so they take the text colour.

const PATHS = {
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  caret: <path d="M6 9l6 6 6-6" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  reset: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></>,
  play: <path d="M7.5 5.5l11 6.5-11 6.5z" fill="currentColor" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  warn: <><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17v.4" /></>,
  scrub: <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M4 12h16" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, strokeWidth = 1.8, className }: {
  name: IconName; size?: number; strokeWidth?: number; className?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}
         style={{ flex: 'none', overflow: 'visible' }}>
      {PATHS[name]}
    </svg>
  );
}
