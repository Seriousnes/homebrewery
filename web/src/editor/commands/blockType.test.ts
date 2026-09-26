// History-safe block type changes (PG-2 carry-over): undo of a type change survives pagination
// splitting or re-joining the block afterwards. Line-model layout (1 column of 10 lines of 10
// characters), TipTap editor with paginatedExtensions.
import { setBlockType } from '@tiptap/pm/commands';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { ReplaceAroundStep } from '@tiptap/pm/transform';
import { afterEach, describe, expect, it } from 'vitest';
import { pageAt } from '../pagination';
import { mountPaginated, type MountedEditor } from '../pagination/testEditor';
import { AUTO, DOC, H, P, PAGE, canonical, li, OL, pageTexts, posOf, schema, seamProblems, UL } from '../pagination/testing';
import { editorActions } from './keymap';
import { convertedContent, setTextblockType, toggleTextblockType } from './blockType';

function words(tag: string, n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${tag}${i} `;
  return s.slice(0, n);
}

/** Ids of the objects on a page. */
const objectIds = (page: PMNode): string[] => (page.attrs.objects as { id: string }[]).map((o) => o.id);

let m: MountedEditor | undefined;
afterEach(() => {
  m?.destroy();
  m = undefined;
});

function mount(doc: PMNode): MountedEditor {
  m = mountPaginated(doc, { lines: { columns: 1 } });
  m.settle();
  return m;
}

const run = (e: MountedEditor, command: ReturnType<typeof setTextblockType>) => command(e.editor.state, e.editor.view.dispatch, e.editor.view);
/** Document JSON without the pids of auto pages (pagination may give re-created pages new ones). */
function layoutJSON(doc: PMNode): unknown {
  const json = doc.toJSON() as { content: { attrs: Record<string, unknown> }[] };
  for (const page of json.content) if (page.attrs.kind === 'auto') delete page.attrs.pid;
  return json;
}
const flow = (e: MountedEditor) => pageTexts(canonical(e.editor.state.doc)).flat();
const types = (e: MountedEditor) => {
  const out: string[] = [];
  canonical(e.editor.state.doc).forEach((page) => page.forEach((b) => out.push(b.type.name)));
  return out;
};

describe('setTextblockType', () => {
  it('changes an unsplit paragraph, carrying its classes and style; the cursor keeps its place', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P('intro'), P('Chapter title', { classes: ['big'], style: 'color: red;', align: 'center' }))));
    e.select(posOf(e.editor.state.doc, 'title'));
    expect(run(e, setTextblockType('heading', { level: 2 }))).toBe(true);
    const block = e.editor.state.doc.child(0).child(1);
    expect(block.type.name).toBe('heading');
    expect(block.attrs).toMatchObject({ level: 2, classes: ['big'], style: 'color: red;' });
    expect(e.editor.state.selection.$head.parent.textContent.slice(e.editor.state.selection.$head.parentOffset)).toBe('title');
  });

  it('changes a split paragraph as a whole: one block in the head\'s place, the cursor keeps its place in the text', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P(words('a', 50)), P(words('b', 100)))));
    expect(e.editor.state.doc.childCount).toBe(2);
    const cursorText = 'b17';
    e.select(posOf(e.editor.state.doc, cursorText)); // in the tail, on page 1
    expect(e.editor.state.selection.$head.index(0)).toBe(1);
    expect(run(e, setTextblockType('codeBlock'))).toBe(true);
    const doc = e.editor.state.doc;
    expect(doc.child(0).lastChild!.type.name).toBe('codeBlock');
    expect(doc.child(0).lastChild!.textContent).toBe(words('b', 100));
    expect(e.editor.state.selection.$head.parent.type.name).toBe('codeBlock');
    expect(e.editor.state.selection.$head.parent.textContent.slice(e.editor.state.selection.$head.parentOffset).startsWith(cursorText)).toBe(true);
    e.settle();
    expect(types(e)).toEqual(['paragraph', 'codeBlock']);
  });

  it('a heading level change on a heading keeps the node (attribute steps)', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, H(1, 'Title'), P('text'))));
    const steps: string[] = [];
    e.editor.on('transaction', ({ transaction }) => transaction.steps.forEach((s) => steps.push(s.constructor.name)));
    e.select(posOf(e.editor.state.doc, 'Title') + 1);
    expect(run(e, setTextblockType('heading', { level: 3 }))).toBe(true);
    expect(e.editor.state.doc.child(0).firstChild!.attrs.level).toBe(3);
    expect(steps).toContain('AttrStep');
  });

  it('turns hard breaks into newlines and drops marks in a code block', () => {
    const bold = schema.marks.bold!.create();
    const content = schema.nodes.paragraph!.create(null, [schema.text('a', [bold]), schema.nodes.hardBreak!.create(), schema.text('b')]).content;
    const converted = convertedContent(content, schema.nodes.codeBlock!, schema);
    expect(converted.childCount).toBe(1);
    expect(converted.firstChild!.text).toBe('a\nb');
    expect(converted.firstChild!.marks).toEqual([]);
  });

  it('toggleTextblockType toggles between a heading and a paragraph', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P('text'))));
    e.select(3);
    run(e, toggleTextblockType('heading', 'paragraph', { level: 2 }));
    expect(e.editor.state.doc.child(0).firstChild!.type.name).toBe('heading');
    run(e, toggleTextblockType('heading', 'paragraph', { level: 2 }));
    expect(e.editor.state.doc.child(0).firstChild!.type.name).toBe('paragraph');
  });

  it('a generated heading id goes with the heading; an author\'s id stays and makes the heading\'s id the author\'s', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, H(2, 'Generated', { id: 'generated' }), P('Mine', { id: 'my-id' }))));
    expect(e.editor.state.doc.child(0).firstChild!.attrs.id).toBe('generated'); // HeadingIds
    e.select(posOf(e.editor.state.doc, 'Generated') + 1);
    run(e, setTextblockType('paragraph'));
    expect(e.editor.state.doc.child(0).firstChild!.attrs.id).toBeNull();
    e.select(posOf(e.editor.state.doc, 'Mine') + 1);
    run(e, setTextblockType('heading', { level: 3 }));
    expect(e.editor.state.doc.child(0).child(1).attrs).toMatchObject({ id: 'my-id', customId: true });
  });
});

describe('undo of a type change survives pagination (PG-2)', () => {
  /** "a…" fills page 0 but one line; a long heading follows (it moves whole to page 1). */
  const headingDoc = () => DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 60)), H(2, words('h', 70)), P(words('c', 20))));

  it('heading → paragraph, then the paragraph is split across pages: undo gives the heading back', () => {
    const e = mount(headingDoc());
    const before = e.editor.state.doc;
    expect(pageTexts(before)).toEqual([[words('a', 60)], [words('h', 70), words('c', 20)]]);
    e.select(posOf(before, 'h3'));
    e.editor.commands.setParagraph(); // TipTap's command (BlockTypeCommands)
    e.settle();
    // The paragraph flows: its first lines fill page 0, the rest continues on page 1.
    expect(e.editor.state.doc.child(1).firstChild!.attrs.continuation).toBe(true);
    expect(e.editor.commands.undo()).toBe(true);
    e.settle();
    expect(types(e)).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(layoutJSON(e.editor.state.doc)).toEqual(layoutJSON(before));
    // And redo.
    expect(e.editor.commands.redo()).toBe(true);
    e.settle();
    expect(types(e)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('control: ProseMirror\'s setBlockType loses that undo (why these commands exist)', () => {
    const e = mount(headingDoc());
    e.select(posOf(e.editor.state.doc, 'h3'));
    setBlockType(e.editor.schema.nodes.paragraph!)(e.editor.state, e.editor.view.dispatch);
    e.settle();
    expect(e.editor.state.doc.child(1).firstChild!.attrs.continuation).toBe(true);
    e.editor.commands.undo();
    e.settle();
    expect(types(e)).toEqual(['paragraph', 'paragraph', 'paragraph']); // the heading is lost
  });

  it('split paragraph → heading, pagination moves the heading, typing, then two undos restore everything', () => {
    const e = mount(DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), P(words('b', 80)), P(words('c', 30)))));
    const before = e.editor.state.doc;
    expect(before.child(1).firstChild!.attrs.continuation).toBe(true);
    e.select(posOf(before, 'b5'));
    e.editor.commands.toggleHeading({ level: 3 });
    e.settle();
    expect(types(e)).toEqual(['paragraph', 'heading', 'paragraph']);
    // The heading (8 lines) can't split: it moved whole to page 1.
    expect(pageTexts(e.editor.state.doc)[1]![0]).toBe(words('b', 80));
    e.editor.view.dispatch(closeHistory(e.editor.state.tr)); // a new undo step for the typing
    e.editor.commands.insertContent('typed ');
    e.settle();
    expect(e.editor.commands.undo()).toBe(true); // the typing
    e.settle();
    expect(e.editor.commands.undo()).toBe(true); // the type change
    e.settle();
    expect(layoutJSON(e.editor.state.doc)).toEqual(layoutJSON(before));
  });

  it('Mod-Alt-0…6 and setHeading use the history-safe commands (no ReplaceAroundStep)', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P('one'), P('two'))));
    const trs: Transaction[] = [];
    e.editor.on('transaction', ({ transaction }) => trs.push(transaction));
    e.select(3);
    e.press('Mod-Alt-2');
    expect(e.editor.state.doc.child(0).firstChild!.attrs.level).toBe(2);
    e.press('Mod-Alt-0');
    expect(e.editor.state.doc.child(0).firstChild!.type.name).toBe('paragraph');
    e.editor.commands.setHeading({ level: 4 });
    expect(e.editor.state.doc.child(0).firstChild!.attrs.level).toBe(4);
    expect(trs.flatMap((tr) => tr.steps).some((s) => s instanceof ReplaceAroundStep)).toBe(false);
  });

  it('setParagraph on a paragraph changes nothing (its align, and a fragment\'s continuation flag, stay)', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, P(words('a', 50)), P(words('b', 100), { align: 'center' }))));
    const before = e.editor.state.doc;
    expect(before.child(1).firstChild!.attrs).toMatchObject({ continuation: true, align: 'center' });
    e.select(pageAt(before, 1)!.contentStart + 3); // in the continuation fragment
    expect(e.editor.commands.setParagraph()).toBe(false);
    e.press('Mod-Alt-0');
    expect(e.editor.state.doc.eq(before)).toBe(true);
  });

  it('a list item paragraph falls back to TipTap (lifted out of the list, then changed)', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, UL(null, li('item')), OL(null, li('other')))));
    e.select(posOf(e.editor.state.doc, 'item') + 1);
    expect(e.editor.commands.setHeading({ level: 2 })).toBe(true);
    expect(e.editor.state.doc.child(0).firstChild!.type.name).toBe('heading');
    expect(flow(e)).toEqual(['item', 'other']);
    expect(pageAt(e.editor.state.doc, 0)).not.toBeNull();
  });
});

describe('list type changes (bullet ↔ numbered) on split lists', () => {
  /** intro + a bullet list of 14 one-line items in one column of 10 lines: the list continues on page 1. */
  const splitList = () => DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P('intro'), UL(null, ...Array.from({ length: 14 }, (_, k) => li(`item ${k + 1}`))), P('after')));
  const lists = (e: MountedEditor) => {
    const out: string[] = [];
    e.editor.state.doc.forEach((page) =>
      page.forEach((b) => {
        if (b.type.name === 'bulletList' || b.type.name === 'orderedList') out.push(`${b.type.name}${b.attrs.continuation ? '(cont)' : ''}${b.type.name === 'orderedList' ? `@${String(b.attrs.start)}` : ''}`);
      }),
    );
    return out;
  };

  it('toggleOrderedList changes every fragment; pagination splits the numbered list again with the right numbers; one undo step', () => {
    const e = mount(splitList());
    const before = e.editor.state.doc;
    expect(lists(e)).toEqual(['bulletList', 'bulletList(cont)']);
    e.select(posOf(before, 'item 12')); // in the fragment on page 1
    expect(e.editor.commands.toggleOrderedList()).toBe(true);
    e.settle();
    expect(lists(e)).toEqual(['orderedList@1', 'orderedList(cont)@10']);
    // The cursor stayed in its item.
    expect(e.editor.state.selection.$head.parent.textContent).toBe('item 12');
    e.editor.commands.undo();
    e.settle();
    expect(layoutJSON(e.editor.state.doc)).toEqual(layoutJSON(before));
  });

  it('control: TipTap\'s toggleList breaks the chain (the fragment it changes loses its continuation)', () => {
    const e = mount(splitList());
    e.select(posOf(e.editor.state.doc, 'item 12'));
    // TipTap's own change of list type: setNodeMarkup on this fragment only.
    const $pos = e.editor.state.selection.$head;
    const listPos = $pos.before($pos.depth - 2);
    e.editor.view.dispatch(e.editor.state.tr.setNodeMarkup(listPos, e.editor.schema.nodes.orderedList));
    e.settle();
    expect(lists(e)).toEqual(['bulletList', 'orderedList@1']);
  });

  it('an unsplit list, and wrapping / lifting, work as in TipTap', () => {
    const e = mount(DOC(PAGE({ columns: 1 }, UL(null, li('one'), li('two')), P('text'))));
    e.select(posOf(e.editor.state.doc, 'one'));
    expect(e.editor.commands.toggleOrderedList()).toBe(true);
    expect(lists(e)).toEqual(['orderedList@1']);
    expect(e.editor.commands.toggleOrderedList()).toBe(true); // lifts out of the list
    expect(e.editor.state.doc.child(0).firstChild!.type.name).toBe('paragraph');
    e.select(posOf(e.editor.state.doc, 'text'));
    expect(e.editor.commands.toggleBulletList()).toBe(true); // wraps
    expect(lists(e)).toContain('bulletList');
  });
});

describe('a block type change onto a page with objects (PGR-2)', () => {
  it('setHeading on a paragraph whose tail is on a page with objects, settle, undo: the objects once, on their page', () => {
    const objects = [{ id: 'o1', kind: 'image', classes: ['banner'], style: 'position:absolute;top:0', src: 'https://example.com/a.png' }];
    const b = words('b', 60);
    m = mountPaginated(
      DOC(PAGE({ columns: 1, pid: 'page0000' }, P(words('a', 70)), P(b.slice(0, 30))), AUTO({ columns: 1, pid: 'objpage1', objects }, P(b.slice(30), { continuation: true }), P(words('d', 30)))),
      { lines: { columns: 1 } },
    );
    m.settle();
    const original = m.editor.state.doc;
    const objectPages = (d: PMNode) => {
      const out: string[] = [];
      d.forEach((page) => {
        if (objectIds(page).length) out.push(`${String(page.attrs.pid)}:${JSON.stringify(objectIds(page))}`);
      });
      return out;
    };
    m.select(posOf(original, 'b2 '));
    expect(m.editor.commands.setHeading({ level: 2 })).toBe(true);
    m.settle();
    expect(objectPages(m.editor.state.doc)).toEqual(['objpage1:["o1"]']);
    expect(m.editor.commands.undo()).toBe(true);
    m.settle();
    expect(objectPages(m.editor.state.doc)).toEqual(['objpage1:["o1"]']);
    expect(canonical(m.editor.state.doc).eq(canonical(original))).toBe(true);
    expect(m.editor.commands.redo()).toBe(true);
    m.settle();
    expect(objectPages(m.editor.state.doc)).toEqual(['objpage1:["o1"]']);
  });
});

describe('wraps act on a whole split paragraph (PGR-3)', () => {
  /** "a…", then "b…" split 50 / 50 over pages 0 and 1. */
  const splitDoc = () => DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), P(words('b', 100))));
  const wraps: [string, (e: MountedEditor) => boolean, string][] = [
    ['toggleBlockquote', (e) => e.editor.commands.toggleBlockquote(), 'blockquote'],
    ['toggleBulletList', (e) => e.editor.commands.toggleBulletList(), 'bulletList'],
    ['toggleOrderedList', (e) => e.editor.commands.toggleOrderedList(), 'orderedList'],
    ['wrapInThemeBlock (Shift-Mod-M)', (e) => editorActions.wrapInThemeBlock(e.editor, ['note']), 'themeBlock'],
  ];
  for (const [name, wrap, wrapper] of wraps) {
    for (const where of ['head', 'continuation'] as const) {
      it(`${name} with the cursor in the ${where}: the whole paragraph is wrapped; undo restores it`, () => {
        const e = mount(splitDoc());
        const original = e.editor.state.doc;
        e.select(where === 'head' ? pageAt(original, 0)!.contentEnd - 5 : pageAt(original, 1)!.contentStart + 5);
        expect(wrap(e)).toBe(true);
        e.settle();
        const flowBlocks = canonical(e.editor.state.doc).child(0);
        expect(flowBlocks.childCount).toBe(2);
        expect(flowBlocks.child(1).type.name).toBe(wrapper);
        expect(flowBlocks.child(1).textContent).toBe(words('b', 100));
        expect(seamProblems(e.editor.state.doc)).toEqual([]);
        expect(e.editor.commands.undo()).toBe(true);
        e.settle();
        expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
      });
    }
  }

  it('Backspace at the start of the page after a wrap finds nothing stale to join', () => {
    const e = mount(splitDoc());
    e.select(pageAt(e.editor.state.doc, 0)!.contentEnd - 5);
    editorActions.wrapInThemeBlock(e.editor, ['note']);
    e.settle();
    let flags = 0;
    e.editor.state.doc.descendants((node) => {
      if (!node.isText && node.attrs.continuation === true) flags++;
    });
    expect(flags).toBe(0);
  });
});

describe('markdown input rules at the start of a split paragraph (P4 carry-over)', () => {
  const typeText = (e: MountedEditor, text: string) => {
    for (const ch of text) {
      const { from, to } = e.editor.state.selection;
      const view = e.editor.view;
      const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };
  const splitDoc = () => DOC(PAGE({ columns: 1, pid: 'aaaaaaaa' }, P(words('a', 50)), P(words('b', 100)), P(words('c', 20))));

  for (const [input, type] of [
    ['# ', 'heading'],
    ['- ', 'bulletList'],
  ] as const) {
    it(`"${input}" at the paragraph's start converts all of it; undo after pagination moved it restores the paragraph`, () => {
      const e = mount(splitDoc());
      const original = e.editor.state.doc;
      expect(original.child(1).firstChild!.attrs.continuation).toBe(true);
      e.select(posOf(original, 'b0 '));
      typeText(e, input);
      e.settle();
      const blocks = canonical(e.editor.state.doc).child(0);
      expect(blocks.child(1).type.name).toBe(type);
      expect(blocks.child(1).textContent).toBe(words('b', 100));
      // The typing and the conversion are one undo step (typed in one go).
      expect(e.editor.commands.undo()).toBe(true);
      e.settle();
      expect(canonical(e.editor.state.doc).eq(canonical(original))).toBe(true);
      expect(seamProblems(e.editor.state.doc)).toEqual([]);
    });
  }
});
