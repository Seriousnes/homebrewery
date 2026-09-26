// Parse rules (plan §7) on real marked-hbfm output: render small HBFM snippets the way upstream
// does and check the JSON the schema's parse rules produce.
import type { JSONContent } from '@tiptap/core';
import { hbfm, type HbfmInjectedTags } from 'marked-hbfm';
import { describe, expect, it } from 'vitest';
import { markMultilineDefinitionLists } from './index';
import { fromDom, fromHtml, normalize, toHtml } from './testing';

/** Renders HBFM, wraps it in a page shell like the importer, and parses it (generateJSON path). */
function parseHbfm(markdown: string, shellAttrs = ''): JSONContent {
  const html = hbfm.render(markdown, 0);
  const root = document.createElement('div');
  root.innerHTML = `<div class="page"${shellAttrs}><div class="columnWrapper">${html}</div></div>`;
  markMultilineDefinitionLists(root);
  return fromHtml(root.innerHTML);
}

/** The blocks of the first page. */
function blocks(doc: JSONContent): JSONContent[] {
  return doc.content?.[0]?.content ?? [];
}

/** Compact outline: type(attr…)[children] with text, for readable assertions. */
function outline(n: JSONContent): unknown {
  if (n.type === 'text') {
    const marks = (n.marks ?? []).map((m) => m.type);
    return marks.length ? { text: n.text, marks } : n.text;
  }
  return n.content ? { [n.type ?? '?']: n.content.map(outline) } : n.type;
}

const attrs = (n: JSONContent | undefined): Record<string, unknown> => n?.attrs ?? {};

/** A one-page document holding `block`. */
const docOfPara = (block: JSONContent): JSONContent => ({ type: 'doc', content: [{ type: 'page', content: [block] }] });

describe('marked-hbfm output → document', () => {
  it('{{monster,frame …}} becomes a themeBlock with the upstream child order', () => {
    const doc = parseHbfm(
      [
        '{{monster,frame',
        '## Goblin',
        '*Small humanoid, neutral evil*',
        '___',
        '**Armor Class** :: 15 (leather armor)',
        '**Hit Points** :: 7 (2d6)',
        '___',
        '| STR | DEX |',
        '|:---:|:---:|',
        '|8 (-1)|14 (+2)|',
        '___',
        'Some text.',
        '}}',
      ].join('\n'),
    );
    const [monster] = blocks(doc);
    expect(monster?.type).toBe('themeBlock');
    expect(attrs(monster).classes).toEqual(['monster', 'frame']);
    expect(monster?.content?.map((c) => c.type)).toEqual([
      'heading',
      'paragraph',
      'horizontalRule',
      'definitionList',
      'horizontalRule',
      'table',
      'horizontalRule',
      'paragraph',
    ]);
    const heading = monster?.content?.[0];
    expect(attrs(heading)).toMatchObject({ level: 2, id: 'goblin', customId: false });
    const dl = monster?.content?.[3];
    expect(attrs(dl).multiline).toBe(false);
    expect(outline(dl!)).toEqual({
      definitionList: [
        { definitionTerm: [{ text: 'Armor Class', marks: ['bold'] }] },
        { definitionDesc: ['15 (leather armor)'] },
        { definitionTerm: [{ text: 'Hit Points', marks: ['bold'] }] },
        { definitionDesc: ['7 (2d6)'] },
      ],
    });
    const table = monster?.content?.[5];
    expect(table?.content?.[0]?.content?.map((c) => [c.type, attrs(c).align])).toEqual([
      ['tableHeader', 'center'],
      ['tableHeader', 'center'],
    ]);
    expect(table?.content?.[1]?.content?.map((c) => c.type)).toEqual(['tableCell', 'tableCell']);
    // Rendering it again gives the CSS-contract structure.
    const html = toHtml(doc);
    expect(html).toContain('<div class="block monster frame"><h2 id="goblin">');
  });

  it('{{wide …}} becomes a themeBlock with the wide class', () => {
    const [wide] = blocks(parseHbfm('{{wide\nWide text\n}}'));
    expect(wide?.type).toBe('themeBlock');
    expect(attrs(wide).classes).toEqual(['wide']);
    expect(outline(wide!)).toEqual({ themeBlock: [{ paragraph: ['Wide text'] }] });
  });

  // UI-8: upstream's generator listed h1–h6 and let the theme's --TOC decide (Blank excludes h4–h6
  // unless .tocDepthH4 … re-includes them). An imported or pasted toc has no data-depth, so it
  // must list every level, like a toc inserted from the Insert menu (depth 6).
  it('{{toc,wide …}} and a pasted upstream toc become a toc node of depth 6', () => {
    const [toc] = blocks(parseHbfm('{{toc,wide\n# Contents\n}}'));
    expect(toc).toMatchObject({ type: 'toc', attrs: { depth: 6, wide: true, title: 'Contents' } });
    const pasted = '<div class="block toc wide"><h1>Contents</h1><ul><li><h3><a href="#p1">x</a></h3></li></ul></div>';
    for (const parse of [fromHtml, fromDom]) expect(parse(pasted).content?.[0]?.content?.[0]?.attrs?.depth).toBe(6);
    // An invalid data-depth also falls back to every level; a valid one is kept.
    expect(fromDom('<div class="block toc" data-depth="9"><h1>Contents</h1><ul></ul></div>').content?.[0]?.content?.[0]?.attrs?.depth).toBe(6);
    expect(fromDom('<div class="block toc" data-depth="2"><h1>Contents</h1><ul></ul></div>').content?.[0]?.content?.[0]?.attrs?.depth).toBe(2);
  });

  it('\\column becomes a columnBreak', () => {
    expect(blocks(parseHbfm('Before\n\\column\nAfter')).map((b) => b.type)).toEqual([
      'paragraph',
      'columnBreak',
      'paragraph',
    ]);
  });

  it(': and :: lines become one spacer per colon', () => {
    expect(blocks(parseHbfm('Para\n:\n::\nNext')).map((b) => b.type)).toEqual([
      'paragraph',
      'spacer',
      'spacer',
      'spacer',
      'paragraph',
    ]);
  });

  it('Term :: Def becomes a single-line definitionList', () => {
    const [dl] = blocks(parseHbfm('Term :: Def\nTerm2 :: Def2'));
    expect(attrs(dl).multiline).toBe(false);
    expect(outline(dl!)).toEqual({
      definitionList: [
        { definitionTerm: ['Term'] },
        { definitionDesc: ['Def'] },
        { definitionTerm: ['Term2'] },
        { definitionDesc: ['Def2'] },
      ],
    });
  });

  it('the multi-line form sets multiline (generateJSON path and clipboard path)', () => {
    const markdown = 'Term\n::Def one\n::Def two\n\nOther\n::Def B';
    const [dl] = blocks(parseHbfm(markdown));
    expect(attrs(dl).multiline).toBe(true);
    expect(outline(dl!)).toEqual({
      definitionList: [
        { definitionTerm: ['Term'] },
        { definitionDesc: ['Def one'] },
        { definitionDesc: ['Def two'] },
        { definitionTerm: ['Other'] },
        { definitionDesc: ['Def B'] },
      ],
    });
    // ProseMirror's own parser on untouched DOM sees the newline directly.
    const clip = fromDom(`<div class="page"><div class="columnWrapper">${hbfm.render(markdown, 0)}</div></div>`);
    expect(attrs(blocks(clip)[0]).multiline).toBe(true);
  });

  it('^sup^ and ^^sub^^ become marks', () => {
    const [para] = blocks(parseHbfm('A ^sup^ and ^^sub^^ text'));
    expect(outline(para!)).toEqual({
      paragraph: ['A ', { text: 'sup', marks: ['superscript'] }, ' and ', { text: 'sub', marks: ['subscript'] }, ' text'],
    });
  });

  it('{{class text}} becomes a span mark; an empty {{…}} becomes an inlineBox', () => {
    const [para] = blocks(parseHbfm('{{pink,color:red,#sid Some **text**}} end {{width:100px}} B'));
    const [some, bold, end, box] = para?.content ?? [];
    expect(some?.marks).toEqual([{ type: 'span', attrs: { classes: ['pink'], style: 'color: red;', id: 'sid', attributes: {} } }]);
    expect(bold?.marks?.map((m) => m.type)).toEqual(['span', 'bold']);
    expect(end).toEqual({ type: 'text', text: ' end ' });
    expect(box).toEqual({ type: 'inlineBox', attrs: { classes: [], style: 'width: 100px;', id: null, attributes: {} } });
  });

  it(':df_d12_2: and the other icon fonts become icon nodes', () => {
    const [para] = blocks(parseHbfm('Roll :df_d12_2: :fas_dice: :far_bell: :gi_zigzag_leaf: :ei_book:'));
    expect(para?.content?.filter((n) => n.type === 'icon').map((n) => attrs(n))).toEqual([
      { font: 'df', glyph: 'd12-2' },
      { font: 'fas', glyph: 'fa-dice' },
      { font: 'far', glyph: 'fa-bell' },
      { font: 'gi', glyph: 'zigzag-leaf' },
      { font: 'ei', glyph: 'book' },
    ]);
    // An <i> without an icon font class is still italic.
    const [italic] = blocks(fromHtml('<p><i class="note">it</i></p>'));
    expect(outline(italic!)).toEqual({ paragraph: [{ text: 'it', marks: ['italic'] }] });
  });

  // RV-7: the theme's Font Awesome CSS also styles fa, fa-solid, fa-regular, fa-brands (and
  // fa-classic); those <i> elements were parsed as empty italic text and silently deleted.
  it('raw Font Awesome 6 and v4 markup becomes icons, kept verbatim', () => {
    const html =
      '<p>a<i class="fa-solid fa-dragon"></i>b<i class="fa fa-dragon"></i><i class="fas fa-dragon"></i><i class="fa-regular fa-star"></i><i class="fa-brands fa-github"></i><i class="fa-classic fa-solid fa-bell"></i></p>';
    const [para] = blocks(fromHtml(`<div class="page"><div class="columnWrapper">${html}</div></div>`));
    expect(para?.content?.map((n) => (n.type === 'icon' ? attrs(n) : n.text))).toEqual([
      'a',
      { font: 'fa-solid', glyph: 'fa-dragon' },
      'b',
      { font: 'fa', glyph: 'fa-dragon' },
      { font: 'fas', glyph: 'fa-dragon' },
      { font: 'fa-regular', glyph: 'fa-star' },
      { font: 'fa-brands', glyph: 'fa-github' },
      { font: 'fa-classic', glyph: 'fa-solid fa-bell' },
    ]);
    const rendered = new DOMParser().parseFromString(toHtml(docOfPara(para!)), 'text/html');
    expect(Array.from(rendered.querySelectorAll('p > i')).map((i) => i.className)).toEqual([
      'fa-solid fa-dragon',
      'fa fa-dragon',
      'fas fa-dragon',
      'fa-regular fa-star',
      'fa-brands fa-github',
      'fa-classic fa-solid fa-bell',
    ]);
  });

  it('tables keep colspan, rowspan, align and percentage widths', () => {
    const [table] = blocks(parseHbfm('| A | B | C |\n|:--|:-:|--:|\n| 1 || 2 |\n| x | y | z |\n|^| w | v |'));
    const rows = table?.content ?? [];
    expect(rows[1]?.content?.map((c) => [attrs(c).colspan, attrs(c).align])).toEqual([
      [2, 'left'],
      [1, 'right'],
    ]);
    expect(attrs(rows[2]?.content?.[0])).toMatchObject({ rowspan: 2, align: 'left' });
    const [widths] = blocks(parseHbfm('| A | B |\n|:--50%--|:--50%--:|\n| 1 | 2 |'));
    expect(widths?.content?.[0]?.content?.map((c) => attrs(c).width)).toEqual(['50%', '50%']);
  });

  it(':- -: :-: paragraphs keep their alignment', () => {
    const para = blocks(parseHbfm(':-: Centered text\n\n-: Right text'));
    expect(para.map((b) => attrs(b).align)).toEqual(['center', 'right']);
  });

  it('heading ids: generated slugs are auto, {#id} injections are custom', () => {
    const b = blocks(parseHbfm('# Title\n## Title\n# Custom\n{#myid}\n### With :df_d12_2: icon'));
    expect(b.map((h) => [attrs(h).id, attrs(h).customId])).toEqual([
      ['title', false],
      ['title-1', false],
      ['myid', true],
      ['with--icon', false],
    ]);
  });

  // RV-13: any id equal to slug(text)-<n> counted as generated, so an author's `{#intro-2}` was
  // renamed to `intro` by the HeadingIds plugin (breaking #intro-2 links).
  it('heading ids: an explicit slug-n id that isn’t the slug at its position stays custom', () => {
    const single = blocks(parseHbfm('## Intro\n{#intro-2}'));
    expect(single.map((h) => [attrs(h).id, attrs(h).customId])).toEqual([['intro-2', true]]);
    // Upstream's own numbering is still recognised as generated.
    const numbered = blocks(parseHbfm('## Intro\n## Intro\n## Other\n{#intro-1}\n## Intro'));
    expect(numbered.map((h) => [attrs(h).id, attrs(h).customId])).toEqual([
      ['intro', false],
      ['intro-1', false],
      ['intro-1', true],
      ['intro-2', false],
    ]);
  });

  it('heading ids from this editor’s clipboard: data-custom-id decides, other ids are generated', () => {
    const doc = fromDom('<h2 id="intro-1" data-pm-slice="0 0 []" data-hb-clipboard="1">Intro</h2><h2 id="x" data-custom-id="">Intro</h2>');
    expect(doc.content?.[0]?.content?.map((h) => [attrs(h).id, attrs(h).customId])).toEqual([
      ['intro-1', false],
      ['x', true],
    ]);
  });

  it('images keep src/alt/title, author classes and style without --HB_src', () => {
    const [para] = blocks(parseHbfm('![alt text](https://example.com/a.png "Title") {width:100px}'));
    expect(attrs(para?.content?.[0])).toMatchObject({
      src: 'https://example.com/a.png',
      alt: 'alt text',
      title: 'Title',
      style: 'width: 100px;',
      attributes: {},
    });
    const [wrapped] = blocks(parseHbfm('![](https://example.com/b.png){wrapLeft}'));
    expect(attrs(wrapped?.content?.[0])).toMatchObject({ classes: ['wrapLeft'], style: null });
    // Rendering puts --HB_src back in front.
    const img = new DOMParser()
      .parseFromString(toHtml(parseHbfm('![](https://example.com/b.png){wrapLeft}')), 'text/html')
      .querySelector('img');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.className).toBe('wrapLeft');
    expect(img?.getAttribute('style')).toMatch(/^--HB_src: ?url\(https:\/\/example\.com\/b\.png\);$/);
  });

  it('{…} block injection sets classes, style, id and safe attributes', () => {
    const [para] = blocks(parseHbfm('A paragraph\n{pink,color:red,#pid,data-x=1}'));
    expect(attrs(para)).toMatchObject({ classes: ['pink'], style: 'color: red;', id: 'pid', attributes: { 'data-x': '1' } });
  });

  it('lists, ordered start, blockquotes, code fences and links', () => {
    const b = blocks(
      parseHbfm('3. three\n4. four\n\n- a\n- b\n\n> quoted\n\n```js\nconst x = 1;\n```\n\n[Link](#p3) and [ext](https://x.com "t")'),
    );
    expect(b.map((n) => n.type)).toEqual(['orderedList', 'bulletList', 'blockquote', 'codeBlock', 'paragraph']);
    expect(attrs(b[0]).start).toBe(3);
    expect(attrs(b[3]).language).toBe('js');
    expect(b[3]?.content?.[0]?.text).toBe('const x = 1;\n');
    const links = (b[4]?.content ?? []).filter((n) => n.marks?.some((m) => m.type === 'link'));
    expect(links.map((n) => n.marks?.[0]?.attrs)).toEqual([
      { href: '#p3', target: null, rel: null, class: null, title: null },
      { href: 'https://x.com', target: null, rel: null, class: null, title: 't' },
    ]);
  });

  it('unknown block HTML becomes rawHtml (sanitized); bare divs stay transparent', () => {
    const b = blocks(
      parseHbfm(
        '<div class="custom" style="color:red">Raw **md**</div>\n\n<section onclick="alert(1)"><img src="x.png" onerror="alert(2)"></section>\n\n<div>Plain</div>',
      ),
    );
    expect(b.map((n) => n.type)).toEqual(['rawHtml', 'rawHtml', 'paragraph']);
    expect(attrs(b[0]).html).toMatch(/^<div class="custom" style="color:red"> <p>Raw <strong>md<\/strong><\/p>\s*<\/div>$/);
    expect(attrs(b[1]).html).toBe('<section><img src="x.png"></section>');
    expect(b[2]?.content?.[0]?.text).toBe('Plain');
  });

  // RV-6: svg/math/video … inside a paragraph were block rawHtml nodes that split the paragraph
  // in three (the text after them a new `p`, indented by the theme's p + p rules).
  it('embedded elements inside text stay inline (rawInline); alone between blocks they are rawHtml', () => {
    const doc = fromHtml(
      '<div class="page"><div class="columnWrapper"><p>Roll <svg class="icon" viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="5"></circle></svg> to hit, then <math><mi>x</mi></math> damage.</p><h2>See <video src="https://example.com/v.mp4"></video> here</h2><svg class="big"></svg></div></div>',
    );
    const b = blocks(doc);
    expect(b.map((n) => n.type)).toEqual(['paragraph', 'heading', 'rawHtml']);
    expect(b[0]?.content?.map((n) => n.type)).toEqual(['text', 'rawInline', 'text', 'rawInline', 'text']);
    expect(attrs(b[0]?.content?.[1]).html).toMatch(/^<svg class="icon" viewBox="0 0 10 10" width="10" height="10"><circle/);
    expect(b[1]?.content?.map((n) => n.type)).toEqual(['text', 'rawInline', 'text']);
    expect(attrs(b[2]).html).toBe('<svg class="big"></svg>');
  });

  it('a marker span left in the flow becomes an inlineBox (the importer lifts markers)', () => {
    const b = blocks(parseHbfm('{{frontCover}}\n\n# Cover'));
    expect(b[0]?.content?.[0]).toMatchObject({ type: 'inlineBox', attrs: { classes: ['frontCover'] } });
    expect(b[1]?.type).toBe('heading');
  });

  it('\\page {…} line tags: the importer shell becomes page attributes', () => {
    // hbfmToDoc (P6.2) reads the \page line with the hbfm lexer and writes the page shell.
    const line = '\\page {pink,color:red,data-x=1}';
    const lexed = hbfm.marked.lexer(line) as unknown as { tokens?: { injectedTags?: HbfmInjectedTags }[] }[];
    const tags = lexed[0]?.tokens?.find((t) => t.injectedTags)?.injectedTags;
    expect(tags).toMatchObject({ classes: 'pink', styles: { color: 'red' }, attributes: { 'data-x': '1' } });
    const style = Object.entries(tags?.styles ?? {})
      .map(([k, v]) => `${k}:${v};`)
      .join(' ');
    const extra = Object.entries(tags?.attributes ?? {})
      .map(([k, v]) => ` ${k}="${v}"`)
      .join('');
    const doc = parseHbfm(
      'Text',
      ` data-kind="manual" data-markers='["frontCover"]' data-footer="Part 1" data-page-number style="${style}"${extra}`,
    );
    const page = doc.content?.[0];
    expect(page?.attrs).toEqual(
      normalize({
        type: 'doc',
        content: [
          {
            type: 'page',
            attrs: {
              kind: 'manual',
              markers: ['frontCover'],
              footer: 'Part 1',
              pageNumber: true,
              style: 'color: red;',
              attributes: { 'data-x': '1' },
            },
            content: [{ type: 'paragraph' }],
          },
        ],
      }).content?.[0]?.attrs,
    );
    // The page's own class list (\page {pink}) goes to classes.
    const withClass = fromHtml('<div class="page pink hb-cols-1"><div class="columnWrapper"><p>x</p></div></div>');
    expect(withClass.content?.[0]?.attrs).toMatchObject({ classes: ['pink'], columns: 1 });
  });

  it('clipboard metadata and editor classes never reach the document', () => {
    const doc = fromDom(
      '<p data-pm-slice="1 1 []" data-hb-clipboard="1" class="ProseMirror-selectednode hb-continued keep">x</p><div data-pm-slice="0 0 []"><p>y</p></div>',
    );
    expect(blocks(doc).map((b) => [b.type, attrs(b).classes, attrs(b).attributes])).toEqual([
      ['paragraph', ['keep'], {}],
      ['paragraph', [], {}],
    ]);
  });
});

