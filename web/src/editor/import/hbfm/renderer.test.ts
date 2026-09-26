// The importer's HBFM renderer must produce the same HTML as marked-hbfm (which upstream renders
// with), minus marked-variables. Compared on every S3 fixture (welcome_msg.md, the theme
// snippets and the tests/markdown cases), page by page, second render pass, as the importer
// renders.
import { hbfm } from 'marked-hbfm';
import { describe, expect, it } from 'vitest';
import { splitTextStyleAndMetadata } from '../brewText';
import { splitPages, stripPageLine } from '../pages';
import { createHbfmRenderer, processStyleTags } from './renderer';

const fixtures = import.meta.glob<string>('../../../../e2e/fixtures/*.hbfm.txt', { query: '?raw', import: 'default', eager: true });
const entries = Object.entries(fixtures)
  .map(([file, text]) => [file.replace(/^.*\//, '').replace(/\.hbfm\.txt$/, ''), text] as const)
  .sort(([a], [b]) => a.localeCompare(b));

function renderBoth(text: string): { ours: string[]; upstream: string[] } {
  const bodies = splitPages(splitTextStyleAndMetadata({ text }).text).map(stripPageLine);
  const renderer = createHbfmRenderer();
  bodies.forEach((b, i) => renderer.render(b, i));
  const ours = bodies.map((b, i) => renderer.render(b, i));
  bodies.forEach((b, i) => hbfm.render(b, i));
  const upstream = bodies.map((b, i) => hbfm.render(b, i));
  return { ours, upstream };
}

describe('createHbfmRenderer matches marked-hbfm', () => {
  it('has fixtures to compare', () => {
    expect(entries.length).toBeGreaterThan(200);
  });

  // marked-variables keeps module-level state between documents (a variable of page 3 of one
  // fixture can be hoisted into another), so fixtures that use variables are checked against
  // upstream's own expectations instead (tests/markdown/variables.test.js in upstreamSuite.test.ts).
  const usesVariables = (text: string) => /\$\[|^\s*\[[^\]]+\]:/m.test(text);

  it.each(entries.filter(([, text]) => !usesVariables(text)))('%s', (_name, text) => {
    const { ours, upstream } = renderBoth(text);
    expect(ours).toEqual(upstream);
  });
});

describe('processStyleTags', () => {
  it('splits classes, id, styles and attributes', () => {
    expect(processStyleTags('pink,#intro,color:red,data-x=1,font-family:"Times New Roman"')).toEqual({
      id: 'intro',
      classes: 'pink',
      styles: { color: 'red', 'font-family': 'Times New Roman' },
      attributes: { 'data-x': '1' },
    });
  });

  it('never assigns __proto__', () => {
    const tags = processStyleTags('__proto__:x,__proto__=y');
    expect(Object.getPrototypeOf(tags.styles ?? {})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('pageLineTags', () => {
  it('reads the tags of a \\page line like upstream', () => {
    const renderer = createHbfmRenderer();
    expect(renderer.pageLineTags('\\page {wide,background-color:#eee,data-x=1}')).toEqual({
      id: null,
      classes: 'wide',
      styles: { 'background-color': '#eee' },
      attributes: { 'data-x': '1' },
    });
    expect(renderer.pageLineTags('\\page')).toBeNull();
  });
});
