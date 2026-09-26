// Inspector model (P3.5): the element chain, pins, the page/section view and InspectorStore.
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { docOf, node, p, page, text } from '@/editor/schema/testing';
import { InspectorStore, mapPin, resolveChain, resolvePage, targetIndex, typeLabel, type Pin } from './model';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** A headless editor after its mount-time passes (heading ids, page ids) ran. */
async function make(content: JSONContent): Promise<Editor> {
  editor = new Editor({ extensions: buildEditorExtensions(), content });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return editor;
}
function posOf(doc: PMNode, test: (n: PMNode) => boolean): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (found < 0 && test(n)) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error('not found');
  return found;
}
const byText = (value: string) => (n: PMNode) => n.isTextblock && n.textContent === value;
const caret = (e: Editor, value: string, offset = 1) =>
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, posOf(e.state.doc, byText(value)) + 1 + offset)));

const nested = () =>
  docOf(
    page([
      node('themeBlock', { classes: ['monster', 'frame'] }, [
        node('bulletList', undefined, [node('listItem', undefined, [p('Item one')])]),
        node('horizontalRule', { classes: ['rule'] }),
        node('table', undefined, [node('tableRow', undefined, [node('tableCell', undefined, [p('Cell')])])]),
      ]),
      p('Outside'),
      node('paragraph', undefined, [
        text('a '),
        text('outer ', [{ type: 'span', attrs: { classes: ['o'] } }]),
        text('both', [
          { type: 'span', attrs: { classes: ['o'] } },
          { type: 'span', attrs: { classes: ['i'] } },
        ]),
      ]),
    ]),
    page([p('Next page')], { kind: 'auto' }),
  );

describe('resolveChain', () => {
  it('lists the inspectable ancestors of a caret, page excluded', async () => {
    const e = await make(nested());
    caret(e, 'Item one');
    expect(resolveChain(e.state).map((c) => c.label)).toEqual(['Theme block', 'Bullet list', 'List item', 'Paragraph']);
    caret(e, 'Cell');
    expect(resolveChain(e.state).map((c) => c.type)).toEqual(['themeBlock', 'table', 'tableRow', 'tableCell', 'paragraph']);
    expect(resolveChain(e.state)[0]!.values.classes).toEqual(['monster', 'frame']);
  });

  it('a range selection gives the common ancestors', async () => {
    const e = await make(nested());
    const from = posOf(e.state.doc, byText('Item one')) + 2;
    const to = posOf(e.state.doc, byText('Cell')) + 2;
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)));
    expect(resolveChain(e.state).map((c) => c.type)).toEqual(['themeBlock']);
    e.view.dispatch(e.state.tr.setSelection(new AllSelection(e.state.doc)));
    expect(resolveChain(e.state)).toEqual([]);
  });

  it('a node selection ends with the selected node', async () => {
    const e = await make(nested());
    const pos = posOf(e.state.doc, (n) => n.type.name === 'horizontalRule');
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, pos)));
    const chain = resolveChain(e.state);
    expect(chain.map((c) => c.type)).toEqual(['themeBlock', 'horizontalRule']);
    expect(chain.at(-1)!.values.classes).toEqual(['rule']);
    expect(chain.at(-1)!.target).toEqual({ kind: 'node', pos });
  });

  it('span marks come last, outermost first, with their ranges', async () => {
    const e = await make(nested());
    caret(e, 'a outer both', 'a outer bo'.length);
    const chain = resolveChain(e.state);
    expect(chain.map((c) => c.label)).toEqual(['Paragraph', 'Span', 'Span']);
    const [, outer, inner] = chain;
    const doc = e.state.doc;
    expect(outer!.target.kind === 'mark' && doc.textBetween(outer!.target.from, outer!.target.to)).toBe('outer both');
    expect(inner!.target.kind === 'mark' && doc.textBetween(inner!.target.from, inner!.target.to)).toBe('both');
    expect(chain.map((c) => c.key)).toEqual(['n2:paragraph', 'm0', 'm1']);
  });

  it('a range inside a span keeps the span; one leaving it does not', async () => {
    const e = await make(nested());
    const start = posOf(e.state.doc, byText('a outer both')) + 1;
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, start + 3, start + 7)));
    expect(resolveChain(e.state).map((c) => c.type)).toEqual(['paragraph', 'span']);
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, start, start + 7)));
    expect(resolveChain(e.state).map((c) => c.type)).toEqual(['paragraph']);
  });

  it('labels', () => {
    expect(typeLabel('heading', { level: 3 })).toBe('Heading 3');
    expect(typeLabel('orderedList')).toBe('Numbered list');
    expect(typeLabel('unknownThing')).toBe('unknownThing');
  });
});

describe('pins', () => {
  it('map through edits and die with their node', async () => {
    const e = await make(nested());
    const pos = posOf(e.state.doc, byText('Outside'));
    const pin: Pin = { kind: 'node', pos, type: 'paragraph' };
    const insert = e.state.tr.insertText('xx', posOf(e.state.doc, byText('Item one')) + 1);
    expect(mapPin(pin, insert)).toEqual({ ...pin, pos: pos + 2 });
    const del = e.state.tr.delete(pos, pos + e.state.doc.nodeAt(pos)!.nodeSize);
    expect(mapPin(pin, del)).toBeNull();
    expect(mapPin(pin, e.state.tr.setMeta('x', 1))).toBe(pin);
  });

  it('pick the pinned item while it is in the chain, else the innermost', async () => {
    const e = await make(nested());
    caret(e, 'Item one');
    const chain = resolveChain(e.state);
    const pin: Pin = { kind: 'node', pos: posOf(e.state.doc, (n) => n.type.name === 'themeBlock'), type: 'themeBlock' };
    expect(targetIndex(chain, pin)).toBe(0);
    expect(targetIndex(chain, null)).toBe(3);
    expect(targetIndex(chain, { ...pin, pos: 999 })).toBe(3);
    expect(targetIndex([], null)).toBe(-1);
  });
});

describe('resolvePage', () => {
  it('reports the page, its section and objects', async () => {
    const e = await make(
      docOf(
        page([p('One')], { footer: 'F', pageNumber: true, markers: ['frontCover'] }),
        page([p('Two')], {
          kind: 'auto',
          footer: 'F',
          objects: [
            { id: 'a', kind: 'image', src: 'https://x.test/img/My%20Map.png?v=2', classes: [], style: '' },
            { id: 'b', kind: 'text', text: '  Long   text that goes on and on and on for quite a while  ', classes: ['artist'], style: '' },
            { id: 'c', kind: 'image', src: 'data:image/png;base64,AAAA', classes: [], style: '' },
          ],
        }),
        page([p('Three')]),
      ),
    );
    caret(e, 'Two');
    const info = resolvePage(e.state)!;
    expect(info).toMatchObject({ index: 1, count: 3, kind: 'auto', markers: [], section: { start: 0, end: 1 } });
    expect(info.section.settings).toMatchObject({ footer: 'F', pageNumber: true });
    expect(info.objects.map((o) => o.label)).toEqual(['My Map.png', 'Long text that goes on and on and on fo…', 'Embedded image']);
    caret(e, 'Three');
    expect(resolvePage(e.state)).toMatchObject({ index: 2, kind: 'manual', section: { start: 2, end: 2 } });
  });
});

describe('InspectorStore', () => {
  it('keeps the same snapshot for transactions that change nothing it shows', async () => {
    const e = await make(nested());
    caret(e, 'Outside');
    const store = new InspectorStore(e);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.getSnapshot();
    // Like pagination: content elsewhere changes, positions move, nothing shown changes.
    e.view.dispatch(e.state.tr.insertText('x', posOf(e.state.doc, byText('Next page')) + 1).setMeta('addToHistory', false));
    e.view.dispatch(e.state.tr.insertText('y', posOf(e.state.doc, byText('Item one')) + 1));
    expect(store.getSnapshot()).toBe(first);
    expect(listener).not.toHaveBeenCalled();
    e.view.dispatch(e.state.tr.setNodeAttribute(posOf(e.state.doc, byText('Outside')), 'classes', ['x']));
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot().chain[0]!.values.classes).toEqual(['x']);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('targetId follows the element, not its position', async () => {
    const e = await make(nested());
    caret(e, 'Outside');
    const store = new InspectorStore(e);
    const unsubscribe = store.subscribe(() => {});
    const id = store.getSnapshot().targetId;
    e.view.dispatch(e.state.tr.insertText('moved ', posOf(e.state.doc, byText('Item one')) + 1));
    caret(e, 'Outside', 3);
    expect(store.getSnapshot().targetId).toBe(id);
    caret(e, 'Next page');
    expect(store.getSnapshot().targetId).not.toBe(id);
    unsubscribe();
  });

  it('select() pins an ancestor; leaving it or selecting the innermost unpins', async () => {
    const e = await make(nested());
    caret(e, 'Item one');
    const store = new InspectorStore(e);
    const unsubscribe = store.subscribe(() => {});
    store.select('n2:themeBlock');
    expect(store.getSnapshot().targetKey).toBe('n2:themeBlock');
    expect(store.target()?.type).toBe('themeBlock');
    // An edit before it moves it; the pin follows.
    e.view.dispatch(e.state.tr.insertText('zz', posOf(e.state.doc, byText('Item one')) + 1).setMeta('addToHistory', false));
    expect(store.target()?.type).toBe('themeBlock');
    caret(e, 'Cell');
    expect(store.getSnapshot().targetKey).toBe('n2:themeBlock');
    caret(e, 'Outside');
    expect(store.getSnapshot().targetKey).toBe('n2:paragraph');
    caret(e, 'Cell');
    expect(store.getSnapshot().targetKey).toBe('n6:paragraph');
    store.select('n5:tableCell');
    expect(store.getSnapshot().targetKey).toBe('n5:tableCell');
    store.select('n6:paragraph');
    expect(store.getSnapshot().targetKey).toBe('n6:paragraph');
    store.select('nope');
    expect(store.getSnapshot().targetKey).toBe('n6:paragraph');
    unsubscribe();
  });

  it('empties when the editor is destroyed', async () => {
    const e = await make(nested());
    const store = new InspectorStore(e);
    const listener = vi.fn();
    store.subscribe(listener);
    e.destroy();
    editor = null;
    expect(store.getSnapshot().chain).toEqual([]);
    expect(store.target()).toBeNull();
    expect(listener).toHaveBeenCalled();
  });
});
