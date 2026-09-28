// Edit source (T5): the source view round-trips every node and mark exactly, and applying source
// replaces exactly the scope, as one step.
import type { JSONContent } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { AUTO, DOC, P, PAGE, PC, posOf } from '../pagination/testing';
import { docOf, docWith, node, normalize, p, page, schema, text } from '../schema/testing';
import { buildApplyTransaction, parseSourceFor, sectionsOf, sourceOf, targetFor, type SourceScope, type SourceTarget } from './index';

const docNode = (json: JSONContent): PMNode => PMNode.fromJSON(schema, normalize(json));
const stateOf = (doc: PMNode, pos?: number) =>
  EditorState.create({ schema, doc, selection: pos === undefined ? undefined : TextSelection.near(doc.resolve(pos)) });

/** Opens the source of `scope` and applies it, optionally edited. */
function roundTrip(doc: PMNode, scope: SourceScope, edit: (text: string) => string = (t) => t, pos?: number) {
  const state = stateOf(doc, pos);
  const target = targetFor(state, scope);
  const snapshot = sourceOf(schema, state.doc, target);
  const parsed = parseSourceFor(schema, target, edit(snapshot.text), snapshot.rawHtml);
  const tr = buildApplyTransaction(state, target, parsed);
  return { state, target, text: snapshot.text, parsed, tr, doc: tr ? tr.doc : state.doc };
}

// One document per node and mark type (the fixtures of schema/roundTrip.test.ts).
const cases: [string, JSONContent][] = [
  ['doc', docOf(page([p('one')]), page([p('two')]))],
  [
    'page',
    docOf(
      page([p('Flow text')], {
        pid: 'k3f9a1qe',
        columns: 2,
        markers: ['frontCover', 'skipCounting'],
        pageNumber: true,
        footer: 'Part 1 | The "Wandering" Inn',
        objects: [
          { id: 'o1', kind: 'image', src: 'https://example.com/inn.png', classes: ['artist'], style: 'position:absolute;bottom:0;right:-80px;height:45%' },
          { id: 'o2', kind: 'text', classes: ['banner'], style: 'position:absolute;top:1cm', text: 'Banner <text>' },
        ],
        classes: ['myPage'],
        style: 'background-color: red;',
        attributes: { 'data-foo': 'bar', lang: 'fr' },
      }),
      page([p('Second section')], { columns: 1 }),
    ),
  ],
  ['paragraph', docWith(p('Centered', { align: 'center', classes: ['lead'], id: 'intro', style: 'color: red;' }), p('  two  spaces\tand a tab '), p(''), p('Plain'))],
  [
    'heading',
    docWith(
      ...[1, 2, 3, 4, 5, 6].map((level) => node('heading', { level }, [text(`Heading ${level}`)])),
      node('heading', { level: 2, id: 'custom', customId: true }, [text('Custom')]),
    ),
  ],
  ['bulletList', docWith(node('bulletList', {}, [node('listItem', {}, [p('a')]), node('listItem', {}, [p('b'), node('bulletList', {}, [node('listItem', {}, [p('nested')])])])]))],
  ['orderedList', docWith(node('orderedList', { start: 3 }, [node('listItem', {}, [p('three')])]), node('orderedList', {}, [node('listItem', {}, [p('one')])]))],
  ['listItem', docWith(node('bulletList', {}, [node('listItem', { classes: ['x'] }, [p('item')])]))],
  [
    'definitionList',
    docWith(
      node('definitionList', {}, [node('definitionTerm', {}, [text('Armor Class', [{ type: 'bold' }])]), node('definitionDesc', {}, [text('15')])]),
      node('definitionList', { multiline: true }, [node('definitionTerm', {}, [text('Term')]), node('definitionDesc', {}, [text('One')]), node('definitionDesc', {}, [text('Two')])]),
    ),
  ],
  ['definitionTerm', docWith(node('definitionList', {}, [node('definitionTerm', {}, [text('T')])]))],
  ['definitionDesc', docWith(node('definitionList', {}, [node('definitionDesc', {}, [text('D')])]))],
  ['blockquote', docWith(node('blockquote', { classes: ['quote'] }, [p('quoted'), p('more')]))],
  ['codeBlock', docWith(node('codeBlock', { language: 'js' }, [text('\nconst x = 1;\n\n  y(<a> & "b");\n')]), node('codeBlock', {}, [text('plain')]))],
  ['horizontalRule', docWith(p('a'), node('horizontalRule', { classes: ['fancy'] }), p('b'))],
  [
    'table',
    docWith(
      node('table', { classes: ['classTable', 'frame'] }, [
        node('tableRow', {}, [node('tableHeader', { colspan: 2, align: 'center', width: '50%' }, [p('Both')]), node('tableHeader', {}, [p('C')])]),
        node('tableRow', {}, [node('tableCell', { rowspan: 2, align: 'left' }, [p('tall')]), node('tableCell', {}, [p('b1')]), node('tableCell', { align: 'right' }, [p('c1'), p('c1b')])]),
        node('tableRow', {}, [node('tableCell', {}, [p('b2')]), node('tableCell', { colwidth: [120] }, [p('c2')])]),
      ]),
    ),
  ],
  ['tableRow', docWith(node('table', {}, [node('tableRow', { classes: ['odd'] }, [node('tableCell', {}, [p('x')])])]))],
  ['tableHeader', docWith(node('table', {}, [node('tableRow', {}, [node('tableHeader', {}, [p('H')])])]))],
  ['tableCell', docWith(node('table', {}, [node('tableRow', {}, [node('tableCell', { colspan: 3 }, [p('C')])])]))],
  [
    'themeBlock',
    docWith(
      node('themeBlock', { classes: ['monster', 'frame'] }, [
        node('heading', { level: 2 }, [text('Goblin')]),
        p('Small humanoid'),
        node('horizontalRule'),
        node('definitionList', {}, [node('definitionTerm', {}, [text('AC')]), node('definitionDesc', {}, [text('15')])]),
        node('table', {}, [node('tableRow', {}, [node('tableHeader', {}, [p('STR')])])]),
      ]),
      node('themeBlock', { classes: ['wide'], style: 'margin-top: 1cm;' }, [p('Wide')]),
    ),
  ],
  ['columnBreak', docWith(p('left'), node('columnBreak'), p('right'))],
  ['spacer', docWith(p('a'), node('spacer'), node('spacer'), p('b'))],
  ['toc', docWith(node('toc', { depth: 2, wide: true, title: 'Contents' }), node('toc', { wide: false, title: 'Index' }))],
  [
    'rawHtml',
    docWith(
      node('rawHtml', { html: '<section class="custom" style="color: red;">\n  <p>Raw <b>html</b></p>\n</section>' }),
      node('rawHtml', { html: '<div>one</div><div>two</div>' }),
      node('rawHtml', { html: '<svg class="diagram" viewBox="0 0 10 10"><path d="M0 0L10 10"></path></svg>' }),
      node('rawHtml', { html: '<div class="custom">kept   as is</div>' }),
      node('rawHtml', { html: '<p>x</p>' }),
    ),
  ],
  [
    'rawInline',
    docWith(
      node('paragraph', {}, [
        text('Roll '),
        node('rawInline', { html: '<svg class="icon" viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="5"></circle></svg>' }),
        text(' to hit, then '),
        node('rawInline', { html: '<math><mi>x</mi></math>' }),
        text(' damage.'),
      ]),
      node('paragraph', {}, [text('Two: '), node('rawInline', { html: '<b>x</b><i>y</i>' })]),
    ),
  ],
  [
    'image',
    docWith(
      node('paragraph', {}, [
        node('image', { src: 'https://example.com/a.png', alt: 'An image', title: 'T', style: 'width: 100px;', classes: ['wrapLeft'] }),
        text(' and '),
        node('image', { src: 'https://example.com/b (1).png', width: 640, height: 480 }),
      ]),
    ),
  ],
  ['icon', docWith(node('paragraph', {}, [text('Roll '), node('icon', { font: 'df', glyph: 'd12-2' }), node('icon', { font: 'fa-solid', glyph: 'fa-dragon' })]))],
  ['inlineBox', docWith(node('paragraph', {}, [text('A '), node('inlineBox', { style: 'width: 100px;', classes: ['spacer'] }), text(' B')]))],
  ['hardBreak', docWith(node('paragraph', {}, [text('line 1'), node('hardBreak'), text('line 2')]))],
  ['text', docWith(p('Just text & <symbols> "quoted"  nbsp'))],
  ...(['bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript'] as const).map(
    (mark): [string, JSONContent] => [mark, docWith(node('paragraph', {}, [text('a '), text('marked', [{ type: mark }]), text(' b')]))],
  ),
  [
    'link',
    docWith(
      node('paragraph', {}, [
        text('see '),
        text('page 3', [{ type: 'link', attrs: { href: '#p3' } }]),
        text(' or '),
        text('site', [{ type: 'link', attrs: { href: 'https://example.com', title: 'Example', target: '_blank', rel: 'noopener' } }]),
      ]),
    ),
  ],
  [
    'span',
    docWith(
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
  ],
];

describe('source round trip: open and apply without edits changes nothing', () => {
  it('covers every node and mark type in the schema', () => {
    const covered = new Set(cases.map(([type]) => type));
    const all = [...Object.keys(schema.nodes), ...Object.keys(schema.marks)];
    expect(all.filter((t) => !covered.has(t))).toEqual([]);
  });

  it.each(cases)('%s', (_type, json) => {
    const doc = docNode(json);
    for (const scope of ['brew', 'section'] as const) {
      const result = roundTrip(doc, scope);
      expect(result.parsed.problems, `${scope}: ${result.text}`).toEqual([]);
      expect(result.tr, `${scope} source:\n${result.text}`).toBeNull();
    }
    // Every block on its own, as the selection scope.
    for (const section of sectionsOf(doc)) {
      for (const item of section.items) {
        const result = roundTrip(doc, 'selection', undefined, item.from + 1);
        expect(result.parsed.problems, result.text).toEqual([]);
        expect(result.tr, `selection source:\n${result.text}`).toBeNull();
      }
    }
  });
});

describe('the source view', () => {
  it('prints one block per line, indents containers and leaves machine noise out', () => {
    const doc = docNode(
      docOf(
        page(
          [
            node('heading', { level: 1, id: 'generated' }, [text('Title')]),
            node('heading', { level: 2, id: 'mine', customId: true }, [text('Mine')]),
            node('bulletList', {}, [node('listItem', {}, [p('one')]), node('listItem', {}, [p('two'), p('more')])]),
            node('paragraph', {}, [node('image', { src: 'https://example.com/a.png', style: 'width: 10px;' })]),
          ],
          { pid: 'abc', pageNumber: true, footer: 'Foot' },
        ),
      ),
    );
    const { text: source } = roundTrip(doc, 'brew');
    expect(source).toBe(
      [
        '<div class="page" data-page-number="" data-footer="Foot">',
        '  <h1>Title</h1>',
        '  <h2 id="mine">Mine</h2>',
        '  <ul>',
        '    <li><p>one</p></li>',
        '    <li>',
        '      <p>two</p>',
        '      <p>more</p>',
        '    </li>',
        '  </ul>',
        '  <p><img src="https://example.com/a.png" style="width: 10px;"></p>',
        '</div>',
      ].join('\n'),
    );
  });

  it('shows a section as one flow: auto pages and split blocks never appear', () => {
    const doc = DOC(PAGE({ pageNumber: true }, P('Intro'), P('The common room smells of cedar,')), AUTO({ pageNumber: true }, PC(' pipe smoke and rain.'), P('Next')), PAGE(null, P('Chapter 2')));
    const { text: source } = roundTrip(doc, 'brew');
    expect(source).toBe(
      [
        '<div class="page" data-page-number="">',
        '  <p>Intro</p>',
        '  <p>The common room smells of cedar, pipe smoke and rain.</p>',
        '  <p>Next</p>',
        '</div>',
        '',
        '<div class="page">',
        '  <p>Chapter 2</p>',
        '</div>',
      ].join('\n'),
    );
  });
});

describe('parsing edited source', () => {
  it('drops indentation but keeps spaces inside text', () => {
    const doc = docNode(docWith(p('x')));
    const { doc: after } = roundTrip(doc, 'selection', () => '<p>\n    Hello   <b>big</b>\n    world\n</p>\n\n<ul>\n  <li>\n    <p>item</p>\n  </li>\n</ul>', 1);
    const blocks = after.child(0).content;
    expect(blocks.child(0).textContent).toBe('Hello   big world');
    expect(blocks.child(1).type.name).toBe('bulletList');
    expect(blocks.child(1).textContent).toBe('item');
  });

  it('reports what the sanitizer removed, new raw HTML and dropped tags', () => {
    const doc = docNode(docWith(p('x')));
    const { parsed } = roundTrip(doc, 'selection', () => '<p onclick="evil()">a<script>x()</script></p><aside class="note">raw</aside><p><font color="red">f</font> <a href="javascript:alert(1)">l</a></p>', 1);
    const kinds = parsed.problems.map((problem) => [problem.kind, problem.message]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['removed', '<script> is not allowed and was removed.'],
        ['removed', 'The attribute onclick is not allowed and was removed.'],
        ['rawHtml', '<aside> has no block equivalent and is kept as raw HTML (a code box in the editor).'],
        ['unwrapped', '<font> has no equivalent: its text is kept, the tag and its attributes are dropped.'],
      ]),
    );
  });

  it('existing raw HTML is not reported again', () => {
    const doc = docNode(docWith(node('rawHtml', { html: '<aside class="note">raw</aside>' })));
    expect(roundTrip(doc, 'brew', (t) => t.replace('raw<', 'edited<')).parsed.problems.map((p) => p.kind)).toEqual(['rawHtml']);
    expect(roundTrip(doc, 'brew').parsed.problems).toEqual([]);
  });

  it('never stores a continuation flag or a generated id from the source', () => {
    const doc = docNode(docWith(p('x')));
    const { doc: after } = roundTrip(doc, 'selection', () => '<p class="hb-continued">a</p><h2 id="given">b</h2><h3>c</h3>', 1);
    const [a, b, c] = [0, 1, 2].map((i) => after.child(0).child(i));
    expect(a!.attrs.continuation).toBe(false);
    expect(b!.attrs).toMatchObject({ id: 'given', customId: true });
    expect(c!.attrs).toMatchObject({ id: null, customId: false });
  });
});

describe('applying: exactly the scope, one step', () => {
  const three = () => DOC(PAGE({ pid: 'a' }, P('one'), P('two'), P('three')), PAGE({ pid: 'b' }, P('four')));

  it('selection: replaces the block at the caret only, with a minimal step', () => {
    const doc = three();
    const result = roundTrip(doc, 'selection', (t) => t.replace('two', 'TWO'), posOf(doc, 'two'));
    expect(result.text).toBe('<p>two</p>');
    expect(result.tr!.steps).toHaveLength(1);
    expect(result.doc.child(0).content.child(1).textContent).toBe('TWO');
    expect(result.doc.child(0).attrs.pid).toBe('a');
    expect(result.doc.textContent).toBe('oneTWOthreefour');
  });

  it('selection: a range of blocks, replaced by more or fewer blocks', () => {
    const doc = three();
    const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, posOf(doc, 'one'), posOf(doc, 'three') + 2) });
    const target = targetFor(state, 'selection');
    expect(target).toEqual({ scope: 'selection', section: 0, start: 0, end: 3 });
    const tr = buildApplyTransaction(state, target, parseSourceFor(schema, target, '<h1>Only</h1>'))!;
    expect(tr.doc.child(0).textContent).toBe('Only');
    expect(tr.doc.child(1).textContent).toBe('four');
  });

  it('selection: empty source deletes the blocks (a page keeps one empty paragraph)', () => {
    const doc = three();
    const state = EditorState.create({ schema, doc, selection: NodeSelection.create(doc, doc.child(0).nodeSize + 1) });
    const target = targetFor(state, 'selection');
    const tr = buildApplyTransaction(state, target, parseSourceFor(schema, target, '  \n'))!;
    expect(tr.doc.childCount).toBe(2);
    expect(tr.doc.child(1).childCount).toBe(1);
    expect(tr.doc.child(1).firstChild!.type.name).toBe('paragraph');
    expect(tr.doc.child(1).textContent).toBe('');
  });

  it('section: page attributes and flow; other sections untouched', () => {
    const doc = three();
    const result = roundTrip(doc, 'section', (t) => t.replace('<div class="page">', '<div class="page hb-cols-1 wide" data-footer="F">').replace('three', 'drei'), posOf(doc, 'one'));
    expect(result.doc.child(0).attrs).toMatchObject({ pid: 'a', kind: 'manual', columns: 1, classes: ['wide'], footer: 'F' });
    expect(result.doc.child(0).textContent).toBe('onetwodrei');
    expect(result.doc.child(1)).toBe(doc.child(1));
  });

  it('brew: sections added, removed and reordered', () => {
    const doc = three();
    const added = roundTrip(doc, 'brew', (t) => `${t}\n<div class="page"><p>five</p></div>`);
    expect(added.doc.childCount).toBe(3);
    expect(added.doc.child(2).attrs).toMatchObject({ kind: 'manual', pid: null });
    expect(added.doc.child(0)).toBe(doc.child(0));

    const removed = roundTrip(doc, 'brew', (t) => t.slice(0, t.indexOf('\n\n')));
    expect(removed.doc.childCount).toBe(1);
    expect(removed.doc.child(0)).toBe(doc.child(0));

    const merged = roundTrip(doc, 'brew', (t) => t.replace('</div>\n\n<div class="page">\n', ''));
    expect(merged.doc.childCount).toBe(1);
    expect(merged.doc.child(0).textContent).toBe('onetwothreefour');

    const emptied = roundTrip(doc, 'brew', () => '');
    expect(emptied.doc.childCount).toBe(1);
    expect(emptied.doc.child(0).textContent).toBe('');
  });

  it('the result is always a valid document', () => {
    const doc = three();
    for (const edit of ['', '<p>a</p>', 'loose text', '<div class="page"></div>', '<li>x</li>', '<td>cell</td>', '<div class="page"><div class="page"><p>x</p></div></div>']) {
      for (const scope of ['selection', 'section', 'brew'] as const) {
        const { doc: after } = roundTrip(doc, scope, () => edit, posOf(doc, 'two'));
        expect(() => after.check(), `${scope}: ${edit}`).not.toThrow();
      }
    }
  });
});

describe('applying across auto pages (pagination interplay)', () => {
  const split = () =>
    DOC(
      PAGE({ pid: 'm', pageNumber: true }, P('Intro'), P('The common room smells of cedar,')),
      AUTO({ pid: 'a1', pageNumber: true }, PC(' pipe smoke and rain.'), P('Middle')),
      AUTO({ pid: 'a2', pageNumber: true }, P('End')),
    );

  it('unchanged source changes nothing, from any page of the section', () => {
    const doc = split();
    for (const needle of ['Intro', 'pipe', 'End']) {
      for (const scope of ['selection', 'section', 'brew'] as const) expect(roundTrip(doc, scope, undefined, posOf(doc, needle)).tr).toBeNull();
    }
  });

  it('the caret on a fragment selects the whole split block', () => {
    const doc = split();
    expect(roundTrip(doc, 'selection', undefined, posOf(doc, 'pipe')).text).toBe('<p>The common room smells of cedar, pipe smoke and rain.</p>');
  });

  it('editing a split block replaces all its fragments; the pages after keep their flow', () => {
    const doc = split();
    const result = roundTrip(doc, 'selection', (t) => t.replace('rain', 'snow'), posOf(doc, 'pipe'));
    const pages = Array.from({ length: result.doc.childCount }, (_, i) => result.doc.child(i));
    expect(pages.map((pg) => pg.attrs.pid as unknown)).toEqual(['m', 'a1', 'a2']);
    expect(pages.map((pg) => pg.textContent)).toEqual(['IntroThe common room smells of cedar, pipe smoke and snow.', 'Middle', 'End']);
    expect(pages[0]!.lastChild!.attrs.continuation).toBe(false);
  });

  it('removing blocks that fill whole auto pages removes those pages; pages with objects stay as placeholders', () => {
    const object = { id: 'o', kind: 'text', classes: ['stain'], style: 'position:absolute', text: '' };
    const doc = DOC(PAGE({ pid: 'm' }, P('A')), AUTO({ pid: 'a1' }, P('B')), AUTO({ pid: 'a2', objects: [object] }, P('C')), AUTO({ pid: 'a3' }, P('D')));
    const result = roundTrip(doc, 'section', (t) => t.replace('<p>B</p>', '').replace('<p>C</p>', ''), posOf(doc, 'A'));
    const pids = Array.from({ length: result.doc.childCount }, (_, i) => result.doc.child(i).attrs.pid as unknown);
    expect(pids).toEqual(['m', 'a2', 'a3']);
    expect(result.doc.child(1).textContent).toBe('');
    expect(result.doc.child(1).attrs.objects).toHaveLength(1);
  });

  it('a target is resolved in the merged view, so pagination moving boundaries in between is harmless', () => {
    const before = split();
    const state = stateOf(before, posOf(before, 'Middle'));
    const target: SourceTarget = targetFor(state, 'selection');
    const snapshot = sourceOf(schema, before, target);
    // Pagination moved "Middle" back to the first page meanwhile.
    const moved = DOC(PAGE({ pid: 'm', pageNumber: true }, P('Intro'), P('The common room smells of cedar, pipe smoke and rain.'), P('Middle')), AUTO({ pid: 'a2', pageNumber: true }, P('End')));
    const tr = buildApplyTransaction(stateOf(moved, 1), target, parseSourceFor(schema, target, snapshot.text.replace('Middle', 'Center')))!;
    expect(tr.doc.child(0).lastChild!.textContent).toBe('Center');
    expect(tr.doc.child(1).textContent).toBe('End');
  });
});
