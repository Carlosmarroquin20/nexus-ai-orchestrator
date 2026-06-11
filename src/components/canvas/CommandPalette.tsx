'use client';

import { useReactFlow } from '@xyflow/react';
import {
  CornerDownLeft,
  Download,
  LayoutTemplate,
  type LucideIcon,
  Maximize,
  Play,
  Plus,
  Search,
  Square,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { NODE_KIND_ORDER, getNodeDescriptor } from '@/config/nodeRegistry';
import { useGraphManipulation } from '@/hooks/useGraphManipulation';
import { useGraphTransfer } from '@/hooks/useGraphPersistence';
import { startRun, stopRun } from '@/services/runExecutor';
import { useActiveRun, useGraphActions, useNexusNodes } from '@/store/useGraphStore';
import { type NexusEdge, type NexusNode, asNodeId } from '@/types/graph';
import { cn } from '@/utils/cn';

import { getNodeIcon } from './icons';

interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: LucideIcon;
  readonly keywords: string;
  readonly perform: () => void;
}

/**
 * Command palette. Opens with Ctrl/Cmd+K (the `ctrlKey || metaKey` check covers
 * Windows and macOS) to search nodes by name/type and run quick actions.
 *
 * Mounted permanently but inert while closed: items are computed only when open,
 * so telemetry-driven node updates do not churn the palette during a run.
 */
export const CommandPalette = (): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const nodes = useNexusNodes();
  const activeRun = useActiveRun();
  const { selectNode } = useGraphActions();
  const { addNodeAtViewportCenter } = useGraphManipulation();
  const { exportToFile, loadDemo } = useGraphTransfer();
  const reactFlow = useReactFlow<NexusNode, NexusEdge>();

  const isRunning = activeRun?.status === 'running';

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Reset transient state whenever the palette opens or the query changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return [];

    const nodeItems: PaletteItem[] = nodes.map((node) => {
      const descriptor = getNodeDescriptor(node.data.kind);
      const nodeId = asNodeId(node.id);
      return {
        id: `node:${node.id}`,
        label: node.data.label.length > 0 ? node.data.label : '(untitled)',
        hint: descriptor.displayName,
        icon: getNodeIcon(node.data.kind),
        keywords: `${node.data.label} ${descriptor.displayName} ${node.data.kind}`.toLowerCase(),
        perform: () => {
          selectNode(nodeId);
          reactFlow.setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 300 });
          setOpen(false);
        },
      };
    });

    const addItems: PaletteItem[] = NODE_KIND_ORDER.map((kind) => {
      const descriptor = getNodeDescriptor(kind);
      return {
        id: `add:${kind}`,
        label: `Add ${descriptor.displayName}`,
        hint: 'Action',
        icon: Plus,
        keywords: `add new ${descriptor.displayName} ${kind}`.toLowerCase(),
        perform: () => {
          addNodeAtViewportCenter(kind);
          setOpen(false);
        },
      };
    });

    const runItem: PaletteItem = isRunning
      ? {
          id: 'run:stop',
          label: 'Stop run',
          hint: 'Action',
          icon: Square,
          keywords: 'stop cancel run pipeline',
          perform: () => {
            stopRun();
            setOpen(false);
          },
        }
      : {
          id: 'run:start',
          label: 'Execute pipeline',
          hint: 'Action',
          icon: Play,
          keywords: 'run execute pipeline start',
          perform: () => {
            startRun();
            setOpen(false);
          },
        };

    const actionItems: PaletteItem[] = [
      runItem,
      {
        id: 'graph:demo',
        label: 'Load demo pipeline',
        hint: 'Action',
        icon: LayoutTemplate,
        keywords: 'demo sample example load pipeline template',
        perform: () => {
          loadDemo();
          setOpen(false);
        },
      },
      {
        id: 'view:fit',
        label: 'Fit view',
        hint: 'Action',
        icon: Maximize,
        keywords: 'fit view zoom center reset',
        perform: () => {
          void reactFlow.fitView({ duration: 300 });
          setOpen(false);
        },
      },
      {
        id: 'graph:export',
        label: 'Export pipeline',
        hint: 'Action',
        icon: Download,
        keywords: 'export download save json',
        perform: () => {
          exportToFile();
          setOpen(false);
        },
      },
    ];

    return [...nodeItems, ...addItems, ...actionItems];
  }, [open, nodes, isRunning, selectNode, addNodeAtViewportCenter, exportToFile, loadDemo, reactFlow]);

  const filtered = useMemo<PaletteItem[]>(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized === '') return items;
    return items.filter(
      (item) => item.keywords.includes(normalized) || item.label.toLowerCase().includes(normalized),
    );
  }, [items, query]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      filtered[activeIndex]?.perform();
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent onKeyDown={onKeyDown}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>

        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- expected for a command palette */}
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search nodes and actions..."
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <ul className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">No matches.</li>
          ) : (
            filtered.map((item, index) => {
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => item.perform()}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                      index === activeIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{item.label}</span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {item.hint}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <CornerDownLeft className="size-3" aria-hidden /> select
          </span>
          <span>↑↓ navigate · Esc close</span>
        </div>
      </DialogContent>
    </Dialog>
  );
};
