import { describe, expect, it } from 'vitest';

import { extractTemplateVariables, renderTemplate } from '@/utils/promptTemplate';

describe('extractTemplateVariables', () => {
  it('extracts unique variables, tolerating inner whitespace', () => {
    expect(extractTemplateVariables('Hi {{name}}, {{ name }} from {{ place }}').sort()).toEqual([
      'name',
      'place',
    ]);
  });

  it('returns an empty list when there are no variables', () => {
    expect(extractTemplateVariables('no variables here')).toEqual([]);
  });
});

describe('renderTemplate', () => {
  it('substitutes every variable reference with the input', () => {
    expect(renderTemplate('Q: {{question}} / again: {{ question }}', 'why?')).toBe(
      'Q: why? / again: why?',
    );
  });

  it('passes the input through when the template is empty', () => {
    expect(renderTemplate('', 'raw input')).toBe('raw input');
  });

  it('leaves a template without variables untouched', () => {
    expect(renderTemplate('static prompt', 'ignored')).toBe('static prompt');
  });

  it('inserts replacement-pattern characters in the input verbatim', () => {
    const input = "costs $$5, ref $& and tail $' plus $1";
    expect(renderTemplate('Q: {{input}} END', input)).toBe(`Q: ${input} END`);
  });

  it('is stable across repeated calls on the shared pattern', () => {
    expect(renderTemplate('{{a}}-{{b}}', 'x')).toBe('x-x');
    expect(renderTemplate('{{a}}-{{b}}', 'y')).toBe('y-y');
  });
});
