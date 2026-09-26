// JSON → HTML → JSON round trips for every node and mark type, plus the CSS contract (plan
// §3.2) of the HTML each one renders.
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { docOf, docWith, dom, fromHtml, node, normalize, p, page, schema, text, toHtml } from './testing';

interface Case {
  /** node or mark type the case covers */
  type: string;
  doc: JSONContent;
  /** CSS-contract checks on the rendered HTML */
  check: (root: HTMLElement, html: string) => void;
}

const q = (root: ParentNode, selector: string): Element => {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
};

const cases: Case[] = [
  {
    type: 'doc',
    doc: docOf(page([p('one')]), page([p('two')], { kind: 'auto' })),
    check: (root) => {
      // Only pages at the top level, so .page:nth-child(even) counts pages.
      expect(Array.from(root.children).map((c) => c.className)).toEqual(['page', 'page']);
    },
  },
  {
    type: 'page',
    doc: docOf(
      page([p('Flow text')], {
        pid: 'k3f9a1qe',
        kind: 'manual',
        columns: 2,
        markers: ['frontCover', 'skipCounting'],
        pageNumber: true,
        footer: 'Part 1 | The Wandering Inn',
        objects: [
          { id: 'o1', kind: 'image', src: 'https://example.com/inn.png', classes: ['artist'], style: 'position:absolute;bottom:0;right:-80px;height:45%' },
          { id: 'o2', kind: 'text', classes: ['banner'], style: 'position:absolute;top:1cm', text: 'Banner text' },
        ],
        classes: ['myPage'],
        style: 'background-color: red;',
        attributes: { 'data-foo': 'bar', lang: 'fr' },
      }),
      page([p('Auto page')], { pid: 'p7x2qe0m', kind: 'auto', columns: 1, pageNumber: true }),
    ),
    check: (root) => {
      const first = q(root, ':scope > div.page:nth-child(1)');
      expect(first.className).toBe('page hb-cols-2 myPage');
      expect(first.getAttribute('data-kind')).toBe('manual');
      expect(first.getAttribute('data-pid')).toBe('k3f9a1qe');
      expect(first.getAttribute('style')).toBe('background-color: red;');
      expect(first.getAttribute('lang')).toBe('fr');
      expect(first.getAttribute('data-foo')).toBe('bar');
      // Chrome first, then the flow in div.columnWrapper.
      const tags = Array.from(first.children).map((c) => `${c.tagName.toLowerCase()}.${c.className.replace(/ /g, '.')}`);
      expect(tags).toEqual([
        'span.inline-block.frontCover',
        'span.inline-block.skipCounting',
        'img.artist',
        'span.inline-block.banner',
        'span.inline-block.footnote',
        'span.inline-block.pageNumber.auto',
        'div.columnWrapper',
      ]);
      expect(q(first, ':scope > span.footnote').textContent).toBe('Part 1 | The Wandering Inn');
      expect(q(first, ':scope > img.artist').getAttribute('style')).toMatch(/position: ?absolute/);
      expect(q(first, ':scope > .columnWrapper > p').textContent).toBe('Flow text');
      const second = q(root, ':scope > div.page:nth-child(2)');
      expect(second.className).toBe('page hb-cols-1');
      expect(second.getAttribute('data-kind')).toBe('auto');
    },
  },
  {
    type: 'paragraph',
    doc: docWith(
      p('Centered', { align: 'center', continuation: true, classes: ['lead'], id: 'intro', style: 'color: red;' }),
      p('Plain'),
    ),
    check: (root) => {
      const para = q(root, '.columnWrapper > p');
      expect(para.getAttribute('align')).toBe('Center');
      expect(para.classList.contains('hb-continued')).toBe(true);
      expect(para.classList.contains('lead')).toBe(true);
      expect(para.id).toBe('intro');
    },
  },
  {
    type: 'heading',
    doc: docWith(
      ...[1, 2, 3, 4, 5, 6].map((level) => node('heading', { level, id: `heading-${level}` }, [text(`Heading ${level}`)])),
      node('heading', { level: 2, id: 'custom', customId: true }, [text('Custom')]),
    ),
    check: (root) => {
      for (const level of [1, 2, 3, 4, 5, 6]) expect(q(root, `h${level}`).id).toBe(`heading-${level}`);
      expect(q(root, 'h2#custom').hasAttribute('data-custom-id')).toBe(true);
    },
  },
  {
    type: 'bulletList',
    doc: docWith(
      node('bulletList', { continuation: true }, [
        node('listItem', {}, [p('a')]),
        node('listItem', { continuation: true }, [p('b'), node('bulletList', {}, [node('listItem', {}, [p('nested')])])]),
      ]),
    ),
    check: (root) => {
      const ul = q(root, '.columnWrapper > ul.hb-continued');
      expect(ul.querySelectorAll(':scope > li')).toHaveLength(2);
      expect(q(ul, ':scope > li.hb-continued > ul > li').textContent).toBe('nested');
    },
  },
  {
    type: 'orderedList',
    doc: docWith(node('orderedList', { start: 3, continuation: true }, [node('listItem', {}, [p('three')])]), node('orderedList', {}, [node('listItem', {}, [p('one')])])),
    check: (root) => {
      expect(q(root, 'ol.hb-continued').getAttribute('start')).toBe('3');
      expect(root.querySelectorAll('ol')[1]?.hasAttribute('start')).toBe(false);
    },
  },
  {
    type: 'listItem',
    doc: docWith(node('bulletList', {}, [node('listItem', { classes: ['x'] }, [p('item')])])),
    check: (root) => expect(q(root, 'ul > li.x > p').textContent).toBe('item'),
  },
  {
    type: 'definitionList',
    doc: docWith(
      node('definitionList', {}, [
        node('definitionTerm', {}, [text('Armor Class', [{ type: 'bold' }])]),
        node('definitionDesc', {}, [text('15')]),
      ]),
      node('definitionList', { multiline: true, continuation: true }, [
        node('definitionTerm', { continuation: true }, [text('Term')]),
        node('definitionDesc', {}, [text('One')]),
        node('definitionDesc', { continuation: true }, [text('Two')]),
      ]),
    ),
    check: (root) => {
      const [single, multi] = Array.from(root.querySelectorAll('dl'));
      expect(single?.innerHTML).toBe('<dt><strong>Armor Class</strong></dt><dd>15</dd>');
      expect(multi?.className).toBe('hb-dl-multiline hb-continued');
      expect(multi?.querySelector('dt')?.className).toBe('hb-continued');
      expect(multi?.querySelectorAll('dd')[1]?.className).toBe('hb-continued');
    },
  },
  {
    type: 'definitionTerm',
    doc: docWith(node('definitionList', {}, [node('definitionTerm', {}, [text('T')])])),
    check: (root) => expect(q(root, 'dl > dt').textContent).toBe('T'),
  },
  {
    type: 'definitionDesc',
    doc: docWith(node('definitionList', {}, [node('definitionDesc', {}, [text('D')])])),
    check: (root) => expect(q(root, 'dl > dd').textContent).toBe('D'),
  },
  {
    type: 'blockquote',
    doc: docWith(node('blockquote', { classes: ['quote'] }, [p('quoted'), p('more')])),
    check: (root) => expect(q(root, 'blockquote.quote').querySelectorAll('p')).toHaveLength(2),
  },
  {
    type: 'codeBlock',
    doc: docWith(node('codeBlock', { language: 'js' }, [text('const x = 1;\n  y();\n')])),
    check: (root) => {
      const code = q(root, 'pre > code.language-js');
      expect(code.textContent).toBe('const x = 1;\n  y();\n');
    },
  },
  {
    type: 'horizontalRule',
    doc: docWith(p('a'), node('horizontalRule'), p('b')),
    check: (root) => expect(q(root, '.columnWrapper > p + hr + p')).toBeTruthy(),
  },
  {
    type: 'table',
    doc: docWith(
      node('table', { classes: ['classTable', 'frame'] }, [
        node('tableRow', {}, [
          node('tableHeader', { colspan: 2, align: 'center', width: '50%' }, [p('Both')]),
          node('tableHeader', {}, [p('C')]),
        ]),
        node('tableRow', {}, [
          node('tableCell', { rowspan: 2, align: 'left' }, [p('tall')]),
          node('tableCell', {}, [p('b1')]),
          node('tableCell', { align: 'right' }, [p('c1')]),
        ]),
        node('tableRow', {}, [node('tableCell', {}, [p('b2')]), node('tableCell', { colwidth: [120] }, [p('c2')])]),
      ]),
    ),
    check: (root, html) => {
      const table = q(root, '.columnWrapper > table.classTable.frame');
      expect(table.getAttribute('style')).toBeNull(); // no TipTap min-width
      const th = q(table, 'tbody > tr > th');
      expect(th.getAttribute('colspan')).toBe('2');
      expect(th.hasAttribute('rowspan')).toBe(false); // 5ePHB: th[colspan]:not([rowspan])
      expect(th.getAttribute('align')).toBe('center');
      expect(th.getAttribute('width')).toBe('50%');
      expect(q(table, 'td[rowspan="2"]').getAttribute('align')).toBe('left');
      expect(html).not.toMatch(/colspan="1"|rowspan="1"|text-align/);
    },
  },
  {
    type: 'tableRow',
    doc: docWith(node('table', {}, [node('tableRow', { classes: ['odd'] }, [node('tableCell', {}, [p('x')])])])),
    check: (root) => expect(q(root, 'table > tbody > tr.odd > td > p').textContent).toBe('x'),
  },
  {
    type: 'tableHeader',
    doc: docWith(node('table', {}, [node('tableRow', {}, [node('tableHeader', {}, [p('H')])])])),
    check: (root) => expect(q(root, 'tr > th').textContent).toBe('H'),
  },
  {
    type: 'tableCell',
    doc: docWith(node('table', {}, [node('tableRow', {}, [node('tableCell', { colspan: 3 }, [p('C')])])])),
    check: (root) => expect(q(root, 'tr > td[colspan="3"]').textContent).toBe('C'),
  },
  {
    type: 'themeBlock',
    doc: docWith(
      node('themeBlock', { classes: ['monster', 'frame'] }, [
        node('heading', { level: 2, id: 'goblin' }, [text('Goblin')]),
        p('Small humanoid'),
        node('horizontalRule'),
        node('definitionList', {}, [node('definitionTerm', {}, [text('AC')]), node('definitionDesc', {}, [text('15')])]),
        node('table', {}, [node('tableRow', {}, [node('tableHeader', {}, [p('STR')])])]),
      ]),
      node('themeBlock', { classes: ['wide'], style: 'margin-top: 1cm;' }, [p('Wide')]),
    ),
    check: (root) => {
      const monster = q(root, '.columnWrapper > div.block.monster.frame');
      expect(monster.className).toBe('block monster frame');
      expect(Array.from(monster.children).map((c) => c.tagName)).toEqual(['H2', 'P', 'HR', 'DL', 'TABLE']);
      expect(q(root, 'div.block.wide').getAttribute('style')).toBe('margin-top: 1cm;');
    },
  },
  {
    type: 'columnBreak',
    doc: docWith(p('left'), node('columnBreak'), p('right')),
    check: (root) => expect(q(root, '.columnWrapper > p + div.columnSplit + p').outerHTML).toBe('<p>right</p>'),
  },
  {
    type: 'spacer',
    doc: docWith(p('a'), node('spacer'), node('spacer'), p('b')),
    check: (root) => expect(root.querySelectorAll('.columnWrapper > div.blank')).toHaveLength(2),
  },
  {
    type: 'toc',
    doc: docWith(node('toc', { depth: 2, wide: true, title: 'Contents' }), node('toc', { wide: false, title: 'Index' })),
    check: (root) => {
      const [wide, narrow] = Array.from(root.querySelectorAll('div.block.toc'));
      expect(wide?.className).toBe('block toc wide');
      expect(wide?.getAttribute('data-depth')).toBe('2');
      expect(wide?.querySelector(':scope > h1')?.textContent).toBe('Contents');
      expect(wide?.querySelector(':scope > h1 + ul')).toBeTruthy();
      expect(narrow?.className).toBe('block toc');
    },
  },
  {
    type: 'rawHtml',
    doc: docWith(
      node('rawHtml', { html: '<section class="custom" style="color: red;"><p>Raw <b>html</b></p></section>' }),
      node('rawHtml', { html: '<div>one</div><div>two</div>' }),
      node('rawHtml', { html: '<svg class="diagram" viewBox="0 0 10 10"><path d="M0 0L10 10"></path></svg>' }),
    ),
    check: (root) => {
      // A single root element is emitted as is; several are wrapped in div[data-hb-raw].
      expect(q(root, '.columnWrapper > section.custom').innerHTML).toBe('<p>Raw <b>html</b></p>');
      expect(q(root, '.columnWrapper > div[data-hb-raw]').children).toHaveLength(2);
      expect(q(root, '.columnWrapper > svg.diagram')).toBeTruthy();
    },
  },
  {
    type: 'rawInline',
    doc: docWith(
      node('paragraph', {}, [
        text('Roll '),
        node('rawInline', { html: '<svg class="icon" viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="5"></circle></svg>' }),
        text(' to hit, then '),
        node('rawInline', { html: '<math><mi>x</mi></math>' }),
        text(' damage.'),
      ]),
      node('paragraph', {}, [text('Two: '), node('rawInline', { html: '<b>x</b><i>y</i>' })]),
    ),
    check: (root) => {
      // Inline in its paragraph, as upstream: no block box, no paragraph split.
      expect(root.querySelectorAll('.columnWrapper > p')).toHaveLength(2);
      expect(q(root, 'p > svg.icon').getAttribute('viewBox')).toBe('0 0 10 10');
      expect(q(root, 'p > math > mi').textContent).toBe('x');
      expect(q(root, 'p > span[data-hb-raw]').innerHTML).toBe('<b>x</b><i>y</i>'); // several roots: an inline wrapper
    },
  },
  {
    type: 'image',
    doc: docWith(
      node('paragraph', {}, [
        node('image', { src: 'https://example.com/a.png', alt: 'An image', title: 'T', style: 'width: 100px;', classes: ['wrapLeft'] }),
        text(' and '),
        node('image', { src: 'https://example.com/b (1).png', width: 640, height: 480 }),
      ]),
    ),
    check: (root) => {
      const [a, b] = Array.from(root.querySelectorAll('img'));
      expect(a?.getAttribute('loading')).toBe('lazy');
      expect(a?.getAttribute('style')).toMatch(/^--HB_src: ?url\(https:\/\/example\.com\/a\.png\); width: 100px;$/);
      expect(a?.className).toBe('wrapLeft');
      expect(a?.getAttribute('alt')).toBe('An image');
      expect(b?.getAttribute('style')).toMatch(/^--HB_src: ?url\("https:\/\/example\.com\/b \(1\)\.png"\);$/);
      expect(b?.getAttribute('width')).toBe('640');
    },
  },
  {
    type: 'icon',
    doc: docWith(
      node('paragraph', {}, [
        text('Roll '),
        node('icon', { font: 'df', glyph: 'd12-2' }),
        node('icon', { font: 'fas', glyph: 'fa-dice' }),
        node('icon', { font: 'gi', glyph: 'zigzag-leaf' }),
        node('icon', { font: 'ei', glyph: 'book' }),
        node('icon', { font: 'fa-solid', glyph: 'fa-dragon' }),
        node('icon', { font: 'fa', glyph: 'fa-dragon' }),
      ]),
    ),
    check: (root) => {
      expect(Array.from(root.querySelectorAll('p > i')).map((i) => i.className)).toEqual([
        'df d12-2',
        'fas fa-dice',
        'gi zigzag-leaf',
        'ei book',
        'fa-solid fa-dragon',
        'fa fa-dragon',
      ]);
      expect(q(root, 'i.df.d12-2').innerHTML).toBe('');
    },
  },
  {
    type: 'inlineBox',
    doc: docWith(node('paragraph', {}, [text('A '), node('inlineBox', { style: 'width: 100px;', classes: ['spacer'] }), text(' B')])),
    check: (root) => {
      const box = q(root, 'p > span.inline-block.spacer');
      expect(box.childNodes).toHaveLength(0);
      expect(box.getAttribute('style')).toBe('width: 100px;');
    },
  },
  {
    type: 'hardBreak',
    doc: docWith(node('paragraph', {}, [text('line 1'), node('hardBreak'), text('line 2')])),
    check: (root) => expect(q(root, 'p').innerHTML).toBe('line 1<br>line 2'),
  },
  {
    type: 'text',
    doc: docWith(p('Just text & <symbols> "quoted"')),
    check: (root) => expect(q(root, 'p').textContent).toBe('Just text & <symbols> "quoted"'),
  },
  // Marks ---------------------------------------------------------------------------------------
  ...(
    [
      ['bold', 'strong'],
      ['italic', 'em'],
      ['underline', 'u'],
      ['strike', 's'],
      ['code', 'code'],
      ['superscript', 'sup'],
      ['subscript', 'sub'],
    ] as const
  ).map(
    ([mark, tag]): Case => ({
      type: mark,
      doc: docWith(node('paragraph', {}, [text('a '), text('marked', [{ type: mark }]), text(' b')])),
      check: (root) => expect(q(root, `p > ${tag}`).textContent).toBe('marked'),
    }),
  ),
  {
    type: 'link',
    doc: docWith(
      node('paragraph', {}, [
        text('see ', []),
        text('page 3', [{ type: 'link', attrs: { href: '#p3' } }]),
        text(' or '),
        text('site', [{ type: 'link', attrs: { href: 'https://example.com', title: 'Example' } }]),
      ]),
    ),
    check: (root) => {
      const [a, b] = Array.from(root.querySelectorAll('a'));
      expect(a?.outerHTML).toBe('<a href="#p3">page 3</a>'); // no target/rel, like upstream
      expect(b?.getAttribute('title')).toBe('Example');
    },
  },
  {
    type: 'span',
    doc: docWith(
      node('paragraph', {}, [
        text('Some ', [{ type: 'span', attrs: { classes: ['pink'], style: 'color: red;', id: 'sid' } }]),
        text('bold', [{ type: 'span', attrs: { classes: ['pink'], style: 'color: red;', id: 'sid' } }, { type: 'bold' }]),
        text(' nested', [
          { type: 'span', attrs: { classes: ['pink'], style: 'color: red;', id: 'sid' } },
          { type: 'span', attrs: { classes: ['inner'] } },
        ]),
        text(' end'),
      ]),
    ),
    check: (root) => {
      // One outer span.inline-block (span is the outermost mark), with the nested one inside.
      const outer = q(root, 'p > span.inline-block.pink');
      expect(root.querySelectorAll('p > span')).toHaveLength(1);
      expect(outer.id).toBe('sid');
      expect(outer.getAttribute('style')).toBe('color: red;');
      expect(outer.innerHTML).toBe('Some <strong>bold</strong><span class="inline-block inner"> nested</span>');
    },
  },
];

describe('schema round trip (JSON → HTML → JSON)', () => {
  it('covers every node and mark type in the schema', () => {
    const covered = new Set(cases.map((c) => c.type));
    const all = [...Object.keys(schema.nodes), ...Object.keys(schema.marks)];
    expect(all.filter((t) => !covered.has(t))).toEqual([]);
  });

  it.each(cases.map((c) => [c.type, c] as const))('%s', (_type, c) => {
    const expected = normalize(c.doc);
    const html = toHtml(c.doc);
    c.check(dom(html), html);

    const parsed = fromHtml(html);
    expect(parsed).toEqual(expected);
    // And the HTML is stable too.
    expect(toHtml(parsed)).toBe(html);
  });
});

// RV-8: the rawHtml catch-all decided on attributes DOMPurify then removed (a bare <div> locked in
// an atom), and single-root HTML another rule claims (<p>, a bare <div>, a span) turned into
// other nodes on the next HTML round trip (clipboard, export → import).
describe('rawHtml: parse decisions and stable HTML round trips', () => {
  const blocksOf = (json: JSONContent) => json.content?.[0]?.content ?? [];

  it.each([
    ['<div onclick="alert(1)">foo</div>'],
    ['<div foo="bar">foo</div>'],
    ['<div data-pm-slice="0 0 []" data-hb-clipboard="1">foo</div>'],
  ])('%s stays transparent: its text is a paragraph', (html) => {
    const parsed = fromHtml(`<div class="page"><div class="columnWrapper">${html}</div></div>`);
    expect(blocksOf(parsed).map((b) => b.type)).toEqual(['paragraph']);
    expect(blocksOf(parsed)[0]?.content?.[0]?.text).toBe('foo');
  });

  it('a div that keeps an attribute is still rawHtml, without clipboard metadata', () => {
    const parsed = fromHtml(
      '<div class="page"><div class="columnWrapper"><div class="custom" onclick="x()" data-pm-slice="0 0 []" data-hb-clipboard="1">foo</div></div></div>',
    );
    expect(blocksOf(parsed)).toEqual([{ type: 'rawHtml', attrs: { html: '<div class="custom">foo</div>' } }]);
  });

  it.each([
    ['<p>x</p>'],
    ['<div>x<p>y</p></div>'],
    ['<span class="watercolor" style="position: absolute;">w</span>'],
    ['<div class="block note">not a theme block</div>'],
    ['<div data-hb-raw="">nested wrapper</div>'],
    ['<section class="custom"><p>kept as is</p></section>'],
    ['<div class="custom">kept as is</div>'],
  ])('rawHtml %s: JSON → HTML → JSON is stable', (html) => {
    const doc = docWith(p('before'), node('rawHtml', { html }), p('after'));
    const parsed = fromHtml(toHtml(doc));
    expect(parsed).toEqual(normalize(doc));
    expect(toHtml(parsed)).toBe(toHtml(doc));
  });
});

// RV-9: reserved classes (columnWrapper, page …) in markers or object classes rendered chrome that
// the page rule's contentElement took for the flow: the flow was lost on the next HTML parse.
describe('page chrome never hijacks the flow', () => {
  it('reserved classes are dropped from markers and object classes; the flow survives JSON → HTML → JSON', () => {
    const doc = docOf(
      page([p('Flow text one'), p('Flow text two')], {
        markers: ['columnWrapper', 'frontCover', 'page', 'ProseMirror-selectednode'],
        objects: [{ id: 'o1', kind: 'text', classes: ['columnWrapper', 'banner'], style: 'position:absolute', text: 'banner' }],
      }),
    );
    const normalized = normalize(doc);
    const attrs = normalized.content?.[0]?.attrs as { markers: string[]; objects: { classes: string[] }[] };
    expect(attrs.markers).toEqual(['columnWrapper', 'frontCover', 'page', 'ProseMirror-selectednode']); // stored as given …
    const html = toHtml(doc);
    const shell = dom(html).firstElementChild!;
    expect(Array.from(shell.children).map((c) => c.className)).toEqual(['inline-block frontCover', 'inline-block banner', 'columnWrapper']); // … rendered clean
    const parsed = fromHtml(html);
    expect(parsed.content?.[0]?.content?.map((b) => b.content?.[0]?.text)).toEqual(['Flow text one', 'Flow text two']);
    expect(parsed.content?.[0]?.attrs).toMatchObject({ markers: ['frontCover'], objects: [{ classes: ['banner'], text: 'banner' }] });
  });

  it('HTML with chrome that carries the wrapper class still parses the real flow', () => {
    const parsed = fromHtml('<div class="page"><span class="inline-block columnWrapper"></span><div class="columnWrapper"><p>Flow</p></div></div>');
    expect(parsed.content?.[0]?.content?.map((b) => [b.type, b.content?.[0]?.text])).toEqual([['paragraph', 'Flow']]);
  });
});
