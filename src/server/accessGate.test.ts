import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AccessGateConfig,
  enforceAccess,
  evaluateAccess,
  readAccessGateConfig,
  refusalFor,
} from '@/server/accessGate';

const basic = (user: string, password: string): string =>
  `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${password}`)))}`;

const gated: AccessGateConfig = { user: 'ada', password: 'secret' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('evaluateAccess', () => {
  it('is open when no credentials are configured', () => {
    expect(evaluateAccess(null, { user: undefined, password: undefined })).toBe('open');
  });

  it('fails closed when only one credential is configured', () => {
    expect(evaluateAccess(basic('ada', 'x'), { user: 'ada', password: undefined })).toBe(
      'misconfigured',
    );
    expect(evaluateAccess(null, { user: undefined, password: 'secret' })).toBe('misconfigured');
  });

  it('grants matching credentials and denies everything else', () => {
    expect(evaluateAccess(basic('ada', 'secret'), gated)).toBe('granted');
    expect(evaluateAccess(null, gated)).toBe('denied');
    expect(evaluateAccess('Bearer token', gated)).toBe('denied');
    expect(evaluateAccess(basic('ada', 'wrong'), gated)).toBe('denied');
    expect(evaluateAccess(basic('eve', 'secret'), gated)).toBe('denied');
    expect(evaluateAccess(basic('ada', 'secret-but-longer'), gated)).toBe('denied');
  });
});

describe('refusalFor', () => {
  it('lets open and granted requests through', () => {
    expect(refusalFor('open')).toBeNull();
    expect(refusalFor('granted')).toBeNull();
  });

  it('answers a denial with a Basic challenge', () => {
    const response = refusalFor('denied')!;
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Basic realm=".+", charset="UTF-8"$/);
  });

  it('answers a misconfiguration with a server error that names the variables', async () => {
    const response = refusalFor('misconfigured')!;
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('NEXUS_AUTH_USER');
  });
});

describe('readAccessGateConfig / enforceAccess', () => {
  const request = (authorization?: string): Request =>
    new Request('http://localhost/', {
      headers: authorization !== undefined ? { Authorization: authorization } : {},
    });

  it('treats empty variables as unset', () => {
    vi.stubEnv('NEXUS_AUTH_USER', '');
    vi.stubEnv('NEXUS_AUTH_PASSWORD', '');
    expect(readAccessGateConfig()).toEqual({ user: undefined, password: undefined });
    expect(enforceAccess(request())).toBeNull();
  });

  it('enforces the configured credentials on a request', () => {
    vi.stubEnv('NEXUS_AUTH_USER', 'ada');
    vi.stubEnv('NEXUS_AUTH_PASSWORD', 'secret');
    expect(enforceAccess(request())?.status).toBe(401);
    expect(enforceAccess(request(basic('ada', 'secret')))).toBeNull();
  });
});
