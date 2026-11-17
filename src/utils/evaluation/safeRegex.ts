/**
 * Linear-time regular expressions for dataset regex checks.
 *
 * Patterns come from dataset files and run on the server against model output.
 * The JavaScript engine backtracks: a pattern such as `^(a+)+$` takes exponential
 * time on a few dozen characters and blocks the event loop, freezing the whole
 * server (ReDoS). RE2 (here its JavaScript port, `re2js`) guarantees time linear
 * in the input. The price is RE2 syntax: backreferences and lookaround are not
 * supported, and such patterns are rejected when a dataset is parsed.
 *
 * Pure; shared by the dataset parser (validation) and the scorers (matching).
 */

import { RE2JS } from 're2js';

/** Dataset flag letters mapped to RE2 flags; `u` is implicit, RE2 matches Unicode. */
const FLAG_BITS: Readonly<Record<string, number>> = {
  i: RE2JS.CASE_INSENSITIVE,
  m: RE2JS.MULTILINE,
  s: RE2JS.DOTALL,
  u: 0,
};

/** Flags a dataset may use. `g`/`y` are excluded: they would make matching stateful. */
const SAFE_REGEX_FLAGS = /^[imsu]*$/;

export interface SafeRegex {
  /** True when the pattern matches anywhere in `text`, like `RegExp.prototype.test`. */
  readonly test: (text: string) => boolean;
}

export type SafeRegexCompileResult =
  | { readonly ok: true; readonly regex: SafeRegex }
  | { readonly ok: false; readonly field: 'pattern' | 'flags'; readonly error: string };

/** Compiles a JavaScript-flavored pattern with RE2 semantics, or explains why it cannot. */
export const compileSafeRegex = (pattern: string, flags: string): SafeRegexCompileResult => {
  if (!SAFE_REGEX_FLAGS.test(flags)) {
    return { ok: false, field: 'flags', error: 'may only contain i, m, s, u.' };
  }
  const bits = [...flags].reduce((acc, flag) => acc | (FLAG_BITS[flag] ?? 0), 0);
  try {
    const compiled = RE2JS.compile(RE2JS.translateRegExp(pattern), bits);
    return { ok: true, regex: { test: (text) => compiled.test(text) } };
  } catch {
    return {
      ok: false,
      field: 'pattern',
      error:
        'is not a valid RE2 regular expression (backreferences and lookaround are not supported).',
    };
  }
};
