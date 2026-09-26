import { describe, expect, it } from 'vitest';
import { createHbfmRenderer } from '../import/hbfm/renderer';
import { docOf, node, p, page, schema, text } from '../schema/testing';
import { collectHeadings, pageNumbering, tocEntries, tocKeyword, tocTree, type TocEntry } from './computeToc';
import { tocHtml, tocInnerHtml } from './renderToc';

const h = (level: number, title: string, attrs: Record<string, unknown> = {}) => node('heading', { level, ...attrs }, title ? [text(title)] : undefined);
const build = (json: ReturnType<typeof docOf>) => schema.nodeFromJSON(json);

describe('pageNumbering (upstream mapPages)', () => {
  it('counts pages, restarts on resetCounting and holds on skipCounting', () => {
    const doc = build(
      docOf(
        page([p('1')]),
        page([p('2')], { markers: ['skipCounting'] }),
        page([p('3')]),
        page([p('4')], { markers: ['resetCounting'] }),
        page([p('5')]),
        page([node('paragraph', { classes: ['skipCounting'] }, [text('6')])]),
        page([p('7'), node('paragraph', undefined, [text('x', [{ type: 'span', attrs: { classes: ['resetCounting'] } }])])]),
      ),
    );
    expect(pageNumbering(doc)).toEqual([
      { number: 1, shown: true },
      { number: 1, shown: false },
      { number: 2, shown: true },
      { number: 1, shown: true },
      { number: 2, shown: true },
      { number: 2, shown: false },
      { number: 1, shown: true },
    ]);
  });
});

describe('tocEntries', () => {
  const doc = build(
    docOf(
      page([h(1, 'Chapter One', { id: 'chapter-one' }), p('a'), h(2, 'Section', { id: 'section' }), h(3, 'Deep', { id: 'deep' }), h(4, 'Deeper', { id: 'deeper' })]),
      page([h(2, '', { id: 'empty' }), h(2, 'Skipped', { id: 'skipped' })], { markers: ['skipCounting'] }),
      page([h(1, 'Chapter Two', { id: 'chapter-two' }), node('themeBlock', { classes: ['monster'] }, [h(2, 'Goblin', { id: 'goblin' })]), h(3, 'No id')]),
    ),
  );

  it('lists headings in order with page numbers and nesting, up to depth', () => {
    const entries = tocEntries(doc, { depth: 3 });
    expect(entries.map((e) => [e.text, e.nest, e.page, e.href])).toEqual([
      ['Chapter One', 0, '1', '#chapter-one'],
      ['Section', 1, '1', '#section'],
      ['Deep', 2, '1', '#deep'],
      ['Chapter Two', 0, '2', '#chapter-two'],
      ['Goblin', 1, '2', '#goblin'],
      ['No id', 2, '2', '#p3'],
    ]);
  });

  it('asks the theme about each candidate (--TOC: exclude)', () => {
    const asked: string[] = [];
    const entries = tocEntries(doc, {
      depth: 6,
      isExcluded: (heading) => {
        asked.push(heading.text);
        return heading.text === 'Goblin' || heading.level >= 4;
      },
    });
    expect(asked).toEqual(['Chapter One', 'Section', 'Deep', 'Deeper', 'Chapter Two', 'Goblin', 'No id']);
    expect(entries.map((e) => e.text)).toEqual(['Chapter One', 'Section', 'Deep', 'Chapter Two', 'No id']);
    // "No id" (h3) now follows an h1: one level of nesting only.
    expect(entries.at(-1)?.nest).toBe(1);
  });

  it('collectHeadings gives positions of the heading nodes', () => {
    for (const heading of collectHeadings(doc)) expect(doc.nodeAt(heading.pos)?.type.name).toBe('heading');
  });

  it('tocKeyword unquotes custom property values', () => {
    expect(tocKeyword(' exclude')).toBe('exclude');
    expect(tocKeyword("'include'")).toBe('include');
    expect(tocKeyword('"exclude" ')).toBe('exclude');
    expect(tocKeyword(null)).toBe('');
  });
});

// Upstream's generator (tableOfContents.gen.js getMarkdown) over the same entries, rendered with
// the HBFM renderer: the oracle for the markup.
function upstreamMarkdown(entries: readonly TocEntry[]): string {
  const levelPad = ['- ###', '  - ####', '    -', '      -', '        -', '          -'];
  const lines = entries.map((e) => `${levelPad[e.nest]} [{{ ${e.text}}}{{ ${e.page}}}](${e.href})`);
  return `{{toc,wide\n# Contents\n\n${lines.join('\n')}\n}}\n`;
}

describe('toc markup', () => {
  const entry = (text: string, nest: number, pageNo = 1): TocEntry => ({ level: nest + 1, nest, text, href: `#${text.toLowerCase()}`, page: String(pageNo), pos: 0 });

  it('is the markup upstream generated (ids aside)', () => {
    const entries = [
      entry('One', 0),
      entry('Two', 1, 2),
      entry('Three', 2, 3),
      entry('Four', 3, 3),
      entry('Five', 2, 4),
      entry('Six', 0, 5),
      entry('Seven', 1, 5),
      entry('Eight', 0, 9),
    ];
    const upstream = createHbfmRenderer().render(upstreamMarkdown(entries), 0).replace(/ id="[^"]*"/g, '');
    const div = document.createElement('div');
    div.innerHTML = upstream;
    const block = div.querySelector('div.block.toc')!;
    expect(tocInnerHtml('Contents', entries)).toBe(block.innerHTML);
    expect(tocHtml({ title: 'Contents', wide: true, depth: 3 }, entries)).toContain('<div class="block toc wide" data-depth="3">');
  });

  it('escapes text', () => {
    const html = tocInnerHtml('A & B', [{ ...entry('x', 0), text: '<b>"hi"</b>', href: '#a"b' }]);
    expect(html).toContain('<h1>A &amp; B</h1>');
    expect(html).toContain('&lt;b&gt;&quot;hi&quot;&lt;/b&gt;');
    expect(html).toContain('href="#a&quot;b"');
  });

  it('has only the title without entries', () => {
    expect(tocInnerHtml('Contents', [])).toBe('<h1>Contents</h1>\n');
  });

  it('tocTree nests by level', () => {
    const tree = tocTree([entry('a', 0), entry('b', 1), entry('c', 2), entry('d', 1), entry('e', 0)]);
    expect(tree.map((i) => [i.entry.text, i.children.map((c) => [c.entry.text, c.children.map((g) => g.entry.text)])])).toEqual([
      ['a', [['b', ['c']], ['d', []]]],
      ['e', []],
    ]);
  });
});
