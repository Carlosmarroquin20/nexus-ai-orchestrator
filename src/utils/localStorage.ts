/**
 * Guarded localStorage access. Reads/writes never throw: private-mode or quota
 * failures degrade to a non-persistent session rather than crashing the app.
 * Browser-only — call from client effects/handlers, never during SSR.
 */

export const readLocalStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export const writeLocalStorage = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Quota exceeded or storage denied: drop the write silently.
  }
};
