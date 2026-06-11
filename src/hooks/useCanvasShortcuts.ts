'use client';

import { useEffect } from 'react';

import { useGraphStore } from '@/store/useGraphStore';

import { useGraphTransfer } from './useGraphPersistence';

/**
 * True when the keyboard event originates from a text-entry control. Used to
 * suppress canvas shortcuts (notably Delete/Backspace) while the user is editing
 * inspector fields — otherwise editing a config value would delete the node.
 */
const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
};

/**
 * Global canvas keyboard shortcuts. Call EXACTLY ONCE at the workspace root.
 *
 * Bindings:
 * - `Delete` / `Backspace` — delete the current selection.
 * - `Escape` — clear the selection.
 * - `Mod+D` — duplicate selected nodes.
 * - `Mod+S` — export the pipeline (overrides the browser's save dialog).
 *
 * React Flow's built-in delete handling is disabled on the canvas
 * (`deleteKeyCode={null}`) so deletion routes exclusively through the store,
 * giving a single predictable code path and consistent selection bookkeeping.
 */
export const useCanvasShortcuts = (): void => {
  const { exportToFile } = useGraphTransfer();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;

      // Save is intentionally global: it fires even from within form fields.
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        exportToFile();
        return;
      }

      // Every other shortcut is suppressed while a text control has focus
      // (notably so Mod+Z drives the input's native undo, not the graph's).
      if (isEditableTarget(event.target)) return;

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) useGraphStore.getState().applyRedo();
        else useGraphStore.getState().applyUndo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        useGraphStore.getState().applyRedo();
        return;
      }

      const { deleteSelected, clearSelection, duplicateSelected } = useGraphStore.getState();

      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelected();
        return;
      }

      switch (event.key) {
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          deleteSelected();
          break;
        case 'Escape':
          clearSelection();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [exportToFile]);
};
