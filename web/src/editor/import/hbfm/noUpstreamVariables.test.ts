// Security guard (P0 finding, plan §1 "Variables … not supported"): imported brews are untrusted
// text, and marked-variables evaluates `$[…]` math with expr-eval, which has unpatched
// prototype-pollution / code-execution advisories. The importer must never load either (nor
// marked-hbfm, which installs marked-variables): these mocks throw as soon as anything imports
// them, so this file fails if the import path ever pulls them in again.
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';
import { mountInlineProbe } from '../../canvas/probe';
import { hbfmToDoc } from '../hbfmToDoc';
import { createHbfmRenderer } from './renderer';

vi.mock('expr-eval', () => {
  throw new Error('expr-eval must not be loaded by the importer');
});
vi.mock('marked-variables', () => {
  throw new Error('marked-variables must not be loaded by the importer');
});
vi.mock('marked-hbfm', () => {
  throw new Error('marked-hbfm (which installs marked-variables) must not be loaded by the importer');
});

const text = (n: JSONContent | undefined): string => (n?.text ?? '') + (n?.content ?? []).map(text).join('');
const probe = () => Promise.resolve(mountInlineProbe());

describe('the importer without marked-variables / expr-eval', () => {
  it('expands variables and math with its own evaluator', async () => {
    const { doc, report } = await hbfmToDoc('[hp]: 12\n\nHP $[hp], double $[hp * 2], $[toRomans(4)]\n\n$[x](5) and $[x + 1]', { probe });
    expect(text(doc)).toBe('HP 12, double 24, IV5 and 6');
    expect(report.variables.definitions.map((d) => d.name)).toEqual(['hp', 'x']);
  });

  it('never reaches properties or code from variable text', async () => {
    const hostile = [
      '$[constructor.constructor(1)()]',
      '$[toString.call(1)]',
      '$[(1).constructor]',
      '$[hasOwnProperty]',
      '[__proto__]: polluted',
      '$[__proto__]',
    ].join('\n\n');
    const { doc } = await hbfmToDoc(hostile, { probe });
    const out = text(doc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(out).toContain('$[constructor.constructor(1)()]$[toString.call(1)]$[(1).constructor]$[hasOwnProperty]');
    expect(out).not.toMatch(/function|native code|\[object/);
    // `__proto__` is just a variable name here (stored in a null-prototype map).
    expect(out.endsWith('polluted')).toBe(true);
  });

  it("'keep' leaves variable syntax as written and still lists the definitions", () => {
    const renderer = createHbfmRenderer({ variables: 'keep' });
    const html = renderer.render('[hp]: 12\n\nHP $[hp] on page $[HB_pageNumber]');
    expect(html).toContain('[hp]: 12');
    expect(html).toContain('HP $[hp] on page $[HB_pageNumber]');
    expect(renderer.variables.definitions).toEqual([{ name: 'hp', page: 0, form: 'block' }]);
    expect(renderer.variables.unresolved.get(0)).toEqual(['$[hp]', '$[HB_pageNumber]']);
  });
});
