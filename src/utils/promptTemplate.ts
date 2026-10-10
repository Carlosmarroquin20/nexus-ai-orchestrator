/**
 * Prompt-template primitives shared by static analysis (variable extraction) and
 * the execution engine (rendering). Both sides must agree on what constitutes a
 * `{{ variable }}` reference, so the pattern is declared exactly once here.
 * Pure and framework-agnostic.
 */

/**
 * A `{{ name }}` reference: optional inner whitespace around an identifier made of
 * word characters, `$`, and `.` (dotted paths). The global flag is required by
 * `matchAll`/`replace`; neither leaves `lastIndex` state behind, so sharing one
 * instance across calls is safe.
 */
const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([\w$.]+)\s*\}\}/g;

/** Extracts the unique `{{ variable }}` references declared inside a template body. */
export const extractTemplateVariables = (template: string): string[] => {
  const found = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found];
};

/**
 * Renders a template by substituting every `{{ variable }}` reference with
 * `input`. An empty template is a passthrough.
 *
 * The substitution goes through a replacer function, never a replacement string:
 * `String.prototype.replace` expands `$&`, `$'`, `` $` `` and `$$` inside a string
 * replacement, which would silently corrupt any input containing a dollar sign
 * (prices, shell snippets, upstream model output).
 */
export const renderTemplate = (template: string, input: string): string =>
  template.length === 0 ? input : template.replace(TEMPLATE_VARIABLE_PATTERN, () => input);
