import { describe, expect, it } from 'vitest';

import { SETTINGS_SCHEMA_VERSION, parseSettings, serializeSettings } from '@/utils/settingsSerialization';
import { safeJsonParse } from '@/utils/telemetryEvent';

describe('settings serialization', () => {
  it('round-trips failRate', () => {
    expect(parseSettings(safeJsonParse(serializeSettings({ failRate: 0.4 })))).toEqual({ failRate: 0.4 });
  });

  it('clamps an out-of-range failRate on parse', () => {
    expect(parseSettings({ version: SETTINGS_SCHEMA_VERSION, failRate: 5 })).toEqual({ failRate: 1 });
    expect(parseSettings({ version: SETTINGS_SCHEMA_VERSION, failRate: -2 })).toEqual({ failRate: 0 });
  });

  it('rejects a wrong version or malformed payload', () => {
    expect(parseSettings({ version: 99, failRate: 0.5 })).toBeNull();
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings({ version: SETTINGS_SCHEMA_VERSION, failRate: 'x' })).toBeNull();
  });
});
