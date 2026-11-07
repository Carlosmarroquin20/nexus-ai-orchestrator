import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { config, proxy } from './proxy';

const request = (path: string, authorization?: string): NextRequest =>
  new NextRequest(`http://localhost${path}`, {
    headers: authorization !== undefined ? { Authorization: authorization } : {},
  });

/** Next marks a pass-through proxy response with this header. */
const passesThrough = (response: Response): boolean =>
  response.headers.get('x-middleware-next') === '1';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy', () => {
  it('passes every request through while the gate is disabled', () => {
    vi.stubEnv('NEXUS_AUTH_USER', '');
    vi.stubEnv('NEXUS_AUTH_PASSWORD', '');
    expect(passesThrough(proxy(request('/')))).toBe(true);
  });

  it('challenges unauthenticated requests and admits valid credentials once enabled', () => {
    vi.stubEnv('NEXUS_AUTH_USER', 'ada');
    vi.stubEnv('NEXUS_AUTH_PASSWORD', 'secret');

    const challenged = proxy(request('/'));
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toContain('Basic');

    expect(passesThrough(proxy(request('/', `Basic ${btoa('ada:secret')}`)))).toBe(true);
  });

  it('excludes build assets from the matcher and covers pages and the API', () => {
    const [pattern] = config.matcher;
    const matcher = new RegExp(`^${pattern}$`);
    expect(matcher.test('/')).toBe(true);
    expect(matcher.test('/api/runs/stream')).toBe(true);
    expect(matcher.test('/_next/static/chunks/app.js')).toBe(false);
    expect(matcher.test('/_next/image')).toBe(false);
    expect(matcher.test('/favicon.ico')).toBe(false);
  });
});
