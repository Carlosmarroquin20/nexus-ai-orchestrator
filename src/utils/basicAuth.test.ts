import { describe, expect, it } from 'vitest';

import { parseBasicAuthorization } from '@/utils/basicAuth';

const encode = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('parseBasicAuthorization', () => {
  it('extracts the user and password', () => {
    expect(parseBasicAuthorization(`Basic ${encode('ada:secret')}`)).toEqual({
      username: 'ada',
      password: 'secret',
    });
  });

  it('accepts any casing of the scheme and surrounding whitespace', () => {
    expect(parseBasicAuthorization(`  bAsIc   ${encode('ada:secret')}  `)).toEqual({
      username: 'ada',
      password: 'secret',
    });
  });

  it('splits on the first colon only, so a password may contain colons', () => {
    expect(parseBasicAuthorization(`Basic ${encode('ada:se:cr:et')}`)?.password).toBe('se:cr:et');
  });

  it('decodes UTF-8 credentials', () => {
    expect(parseBasicAuthorization(`Basic ${encode('josé:contraseña')}`)).toEqual({
      username: 'josé',
      password: 'contraseña',
    });
  });

  it('allows an empty password', () => {
    expect(parseBasicAuthorization(`Basic ${encode('ada:')}`)).toEqual({
      username: 'ada',
      password: '',
    });
  });

  it('rejects absent, foreign-scheme, and malformed headers', () => {
    expect(parseBasicAuthorization(null)).toBeNull();
    expect(parseBasicAuthorization('')).toBeNull();
    expect(parseBasicAuthorization(`Bearer ${encode('ada:secret')}`)).toBeNull();
    expect(parseBasicAuthorization('Basic')).toBeNull();
    expect(parseBasicAuthorization('Basic not*base64!')).toBeNull();
    expect(parseBasicAuthorization(`Basic ${encode('no-separator')}`)).toBeNull();
    // Valid base64 whose bytes are not UTF-8.
    expect(parseBasicAuthorization(`Basic ${btoa('ÿþ:x')}`)).toBeNull();
  });
});
