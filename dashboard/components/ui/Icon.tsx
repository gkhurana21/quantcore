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
  // workspaces (bottom bar on phones)
  build: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  price: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v10M14.8 9.4c-.5-.9-1.5-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2s1.1 1.7 2.8 2 2.8.8 2.8 2-1.2 2-2.8 2c-1.3 0-2.4-.5-2.9-1.5" /></>,
  simulate: <path d="M3 17c3-1 4-9 7-9s3 7 6 7 3-6 5-7M3 12h2M3 21h18" />,
  exotics: <><path d="M12 3l8.5 5v8L12 21l-8.5-5V8z" /><path d="M12 12l8.5-4M12 12v9M12 12L3.5 8" /></>,
  stress: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
  risk: <><path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z" /><path d="M12 8v5M12 16v.4" /></>,
  engine: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
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
