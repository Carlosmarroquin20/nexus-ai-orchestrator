/**
 * Canonical text form shared by the dataset parser (to reject expectations that
 * normalize to nothing) and the scorers (to compare outputs). Pure.
 */

/** Characters stripped from both ends: quotes and Markdown/sentence punctuation. */
const EDGE_DECORATION = /^[\s"'`*_.,;:!?()[\]]+|[\s"'`*_.,;:!?()[\]]+$/g;

/**
 * Canonical form for text comparison: Unicode-compatibility normalized,
 * lower-cased, whitespace collapsed, and stripped of surrounding quotes and
 * punctuation. Models decorate short answers ("Billing.", "**billing**") without
 * changing their meaning; this form ignores that decoration.
 */
export const normalizeOutput = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').replace(EDGE_DECORATION, '');
