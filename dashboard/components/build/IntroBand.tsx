'use client';

import { Icon } from '@/components/ui/Icon';
import { keyHint } from '@/lib/shortcuts';
import b from './build.module.css';

export interface IntroExample { id: string; short: string; meta: string; testid?: string; run: () => void; }

/**
 * Shown on first visit under the strip on Build: what this is, four one-click examples (the same ones the
 * command palette offers) and where the shortcuts are. One row on a desktop, wrapping on a phone. It is in the
 * page's HTML always and hidden by CSS from <html data-intro="off">, so a returning visitor never sees it flash
 * and nothing moves when React takes over (see lib/intro.ts).
 */
export function IntroBand({ examples, onDismiss }: { examples: IntroExample[]; onDismiss: () => void }) {
  return (
    <div className={b.introWrap} data-intro-band>
      <section className={b.intro} aria-label="About this terminal" data-testid="intro-band">
        <p className={b.introText}>
          <strong>Options pricing and risk terminal.</strong> The C++ engine runs in your browser via WebAssembly.
        </p>
        <div className={b.introTry} role="group" aria-label="Try an example">
          <span className={b.introLabel}>Try</span>
          {examples.map(x => (
            <button key={x.id} type="button" className={b.introBtn} data-testid={`intro-${x.id}`} onClick={x.run}>
              {x.short}<span className={b.introTo}>{x.meta}</span>
            </button>
          ))}
        </div>
        <p className={b.introHint}>
          Press <kbd className={b.introKbd}>{keyHint('shortcuts')}</kbd> for shortcuts · <kbd className={b.introKbd}>{keyHint('palette-chord')}</kbd> for everything
        </p>
        <button type="button" className={b.introClose} onClick={onDismiss} aria-label="Dismiss the introduction" data-testid="intro-dismiss">
          <Icon name="close" size={14} />
        </button>
      </section>
    </div>
  );
}
