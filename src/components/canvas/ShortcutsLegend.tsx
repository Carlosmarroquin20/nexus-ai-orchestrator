'use client';

import { Panel } from '@xyflow/react';

const SHORTCUTS: readonly { readonly keys: string; readonly label: string }[] = [
  { keys: 'Del', label: 'Delete' },
  { keys: 'Esc', label: 'Deselect' },
  { keys: '⌘/Ctrl D', label: 'Duplicate' },
  { keys: '⌘/Ctrl S', label: 'Export' },
];

/** Unobtrusive shortcut reference rendered along the bottom of the canvas. */
export const ShortcutsLegend = (): JSX.Element => (
  <Panel
    position="bottom-center"
    className="flex items-center gap-3 rounded-md border border-border bg-card/85 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur"
  >
    {SHORTCUTS.map((shortcut) => (
      <span key={shortcut.keys} className="flex items-center gap-1">
        <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[9px] text-foreground">
          {shortcut.keys}
        </kbd>
        {shortcut.label}
      </span>
    ))}
  </Panel>
);
