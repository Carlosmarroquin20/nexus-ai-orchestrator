'use client';

import { useEffect } from 'react';

import { useGraphStore } from '@/store/useGraphStore';
import { readLocalStorage, writeLocalStorage } from '@/utils/localStorage';
import {
  SETTINGS_STORAGE_KEY,
  parseSettings,
  serializeSettings,
} from '@/utils/settingsSerialization';
import { safeJsonParse } from '@/utils/telemetryEvent';

const SAVE_DEBOUNCE_MS = 400;

/**
 * Persists workspace settings (currently `failRate`) to localStorage. Call once
 * at the workspace root. Independent of graph persistence: it subscribes only to
 * settings fields, so graph/telemetry changes never trigger a settings write and
 * vice versa. SSR-safe — the effect is client-only.
 */
export const useSettingsPersistence = (): void => {
  useEffect(() => {
    const raw = readLocalStorage(SETTINGS_STORAGE_KEY);
    if (raw !== null) {
      const settings = parseSettings(safeJsonParse(raw));
      if (settings !== null) useGraphStore.getState().setFailRate(settings.failRate);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useGraphStore.subscribe((state, previous) => {
      if (state.failRate === previous.failRate) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        writeLocalStorage(SETTINGS_STORAGE_KEY, serializeSettings({ failRate: state.failRate }));
      }, SAVE_DEBOUNCE_MS);
    });

    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, []);
};
