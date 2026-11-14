'use client';

import type { ReactNode } from 'react';
import type { TabId } from '@/components/terminal/useTerminalState';
import { workspaceOf } from '@/components/terminal/useTerminalState';
import w from './workspace.module.css';

/**
 * A research workspace: its title, the line that says what it is for, and the panel itself. The
 * title is the only place the terminal uses its display face — it marks where you are without a
 * second row of tabs.
 */
export function WorkspaceView({ id, actions, children }: { id: TabId; actions?: ReactNode; children: ReactNode }) {
  const ws = workspaceOf(id);
  return (
    <section className={w.workspace} aria-label={ws.label}>
      <header className={w.head}>
        <div className={w.heading}>
          <h2 className={w.title}>{ws.label}</h2>
          <p className={w.dek}>{ws.dek}</p>
        </div>
        {actions && <div className={w.actions}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}
