import { describe, expect, it, vi } from 'vitest';
import { serverJsonLength } from '@/editor/snippets/storedSnippets';
import { SIZE_REFUSED, SnippetsEditorStore } from './snippetsEditorStore';

const stored = [
  { group: 'Tables', name: 'Loot', gen: '|a|' },
  { name: 'Note', gen: '{{note\nHi\n}}' },
];

function setup(value: unknown = stored, options: { maxSize?: number } = {}) {
  let time = 0;
  const onChange = vi.fn();
  const store = new SnippetsEditorStore(value, { onChange, now: () => time, ...options });
  return {
    store,
    onChange,
    tick: (ms: number) => {
      time += ms;
    },
    names: () => store.getSnapshot().snippets.map((s) => s.name),
    last: () => onChange.mock.calls.at(-1)?.[0] as unknown,
  };
}

describe('SnippetsEditorStore', () => {
  it('starts from the stored value (any shape), selects the first snippet and reports nothing', () => {
    const { store, onChange } = setup();
    const snap = store.getSnapshot();
    expect(snap.snippets.map(({ group, name, gen }) => ({ group, name, gen }))).toEqual([
      { group: 'Tables', name: 'Loot', gen: '|a|' },
      { group: '', name: 'Note', gen: '{{note\nHi\n}}' },
    ]);
    expect(snap.selected).toBe(snap.snippets[0]!.key);
    expect(snap.size).toBe(serverJsonLength(stored));
    expect(store.value()).toBe(stored);
    expect(onChange).not.toHaveBeenCalled();
    expect(new SnippetsEditorStore('\\snippet A\nbody\n').getSnapshot().snippets.map((s) => s.name)).toEqual(['A']);
    expect(new SnippetsEditorStore(null).getSnapshot()).toMatchObject({ snippets: [], selected: null, size: 4 });
  });

  it('adds, edits, duplicates, swaps and deletes, reporting the stored form each time', () => {
    const { store, names, last } = setup();
    const [loot, note] = store.getSnapshot().snippets;
    const added = store.add({ group: 'Tables', name: 'New snippet', gen: '' })!;
    // After the selected snippet.
    expect(names()).toEqual(['Loot', 'New snippet', 'Note']);
    expect(store.getSnapshot().selected).toBe(added);
    expect(last()).toEqual([stored[0], { group: 'Tables', name: 'New snippet', gen: '' }, stored[1]]);

    expect(store.update(added, 'name', ' Treasure ')).toBe(true);
    expect(last()).toEqual([stored[0], { group: 'Tables', name: 'Treasure', gen: '' }, stored[1]]);

    const copy = store.duplicate(note!.key, 'Note copy')!;
    expect(names()).toEqual(['Loot', ' Treasure ', 'Note', 'Note copy']);
    expect(store.getSnapshot().selected).toBe(copy);

    expect(store.swap(copy, note!.key)).toBe(true);
    expect(names()).toEqual(['Loot', ' Treasure ', 'Note copy', 'Note']);

    expect(store.remove(loot!.key, added)).toBe(true);
    expect(names()).toEqual([' Treasure ', 'Note copy', 'Note']);
    expect(store.getSnapshot().selected).toBe(added);

    for (const s of store.getSnapshot().snippets) store.remove(s.key, null);
    // No snippets: null (the server stores nothing).
    expect(last()).toBeNull();
    expect(store.getSnapshot().selected).toBeNull();
  });

  it('merges typing into one undo step, and undo/redo select what they changed', () => {
    const { store, tick, last } = setup();
    const [loot, note] = store.getSnapshot().snippets;
    store.select(note!.key);
    for (const text of ['{{note\nHi!\n}}', '{{note\nHi!!\n}}', '{{note\nHi!!!\n}}']) {
      tick(200);
      store.update(note!.key, 'gen', text);
    }
    tick(200);
    store.update(loot!.key, 'name', 'Loot table');
    expect(store.getSnapshot().canUndo).toBe(true);

    store.undo();
    expect(store.get(loot!.key)!.name).toBe('Loot');
    expect(store.getSnapshot().selected).toBe(note!.key);
    store.undo();
    // The three keystrokes were one step.
    expect(store.get(note!.key)!.gen).toBe('{{note\nHi\n}}');
    expect(store.getSnapshot().canUndo).toBe(false);
    // Back at the start: the value it was given, unchanged.
    expect(last()).toBe(stored);

    store.redo();
    expect(store.get(note!.key)!.gen).toBe('{{note\nHi!!!\n}}');
    store.redo();
    expect(store.get(loot!.key)!.name).toBe('Loot table');
    expect(store.getSnapshot().selected).toBe(loot!.key);
    expect(store.getSnapshot().canRedo).toBe(false);
  });

  it("doesn't merge after a pause, a blur (breakMerge), another field or merge: false", () => {
    const { store, tick } = setup();
    const key = store.getSnapshot().snippets[0]!.key;
    store.update(key, 'name', 'L1');
    tick(1500);
    store.update(key, 'name', 'L2');
    store.breakMerge();
    store.update(key, 'name', 'L3');
    store.update(key, 'group', 'G');
    store.update(key, 'group', 'G2', { merge: false });
    const steps: string[] = [];
    while (store.undo()) steps.push(`${store.get(key)!.name}/${store.get(key)!.group}`);
    expect(steps).toEqual(['L3/G', 'L3/Tables', 'L2/Tables', 'L1/Tables', 'Loot/Tables']);
  });

  it('refuses edits over the size limit with a notice, but always allows shrinking', () => {
    const size = serverJsonLength([{ name: 'A', gen: 'x'.repeat(50) }]);
    const { store, onChange } = setup([{ name: 'A', gen: 'x'.repeat(50) }], { maxSize: size + 5 });
    const key = store.getSnapshot().snippets[0]!.key;
    expect(store.fits(key, { gen: 'x'.repeat(55) })).toBe(true);
    expect(store.fits(key, { gen: 'x'.repeat(56) })).toBe(false);
    expect(store.update(key, 'gen', 'x'.repeat(56))).toBe(false);
    expect(store.getSnapshot().notice).toMatchObject({ tone: 'error', message: SIZE_REFUSED });
    expect(store.add({ group: '', name: 'B', gen: '' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // A successful edit clears the error.
    expect(store.update(key, 'gen', 'x')).toBe(true);
    expect(store.getSnapshot().notice).toBeNull();
    expect(store.getSnapshot().size).toBe(serverJsonLength([{ name: 'A', gen: 'x' }]));
  });

  it('imports snippets after the others or instead of them, as one undo step', () => {
    const { store, names } = setup();
    const keys = store.importSnippets(
      [
        { group: '', name: 'One', gen: '1' },
        { group: 'G', name: 'Two', gen: '2' },
      ],
      'append',
    );
    expect(names()).toEqual(['Loot', 'Note', 'One', 'Two']);
    expect(store.getSnapshot().selected).toBe(keys[0]);
    store.importSnippets([{ group: '', name: 'Only', gen: 'o' }], 'replace');
    expect(names()).toEqual(['Only']);
    store.undo();
    expect(names()).toEqual(['Loot', 'Note', 'One', 'Two']);
    expect(store.importSnippets([], 'replace')).toEqual([]);
  });

  it('sync: its own values (even stale ones) change nothing; other values replace the list and the history', () => {
    const { store, onChange, names } = setup();
    const key = store.getSnapshot().snippets[0]!.key;
    store.update(key, 'name', 'A');
    const first = onChange.mock.calls.at(-1)![0] as unknown;
    store.update(key, 'name', 'AB');
    // A render that lags behind typing.
    store.sync(first);
    expect(names()).toEqual(['AB', 'Note']);
    expect(store.getSnapshot().canUndo).toBe(true);

    // The saved version loaded again (a new object).
    const server = [{ name: 'Server', gen: 's' }];
    store.sync(server);
    expect(names()).toEqual(['Server']);
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.value()).toBe(server);

    // null from outside while the store has snippets: cleared (not mistaken for its own value).
    store.sync(null);
    expect(names()).toEqual([]);
    // The same null again: nothing to do.
    const listener = vi.fn();
    store.subscribe(listener);
    store.sync(null);
    expect(listener).not.toHaveBeenCalled();
  });

  it('announces messages with a new id each time', () => {
    const { store } = setup();
    store.announce('Hello');
    const a = store.getSnapshot().notice!;
    store.announce('Hello');
    expect(store.getSnapshot().notice!.id).not.toBe(a.id);
    expect(store.getSnapshot().notice).toMatchObject({ tone: 'info', message: 'Hello' });
  });

  it('keeps at most maxSteps undo steps', () => {
    const store = new SnippetsEditorStore(stored, { maxSteps: 3 });
    const key = store.getSnapshot().snippets[0]!.key;
    for (let i = 0; i < 6; i++) store.update(key, 'name', `N${i}`, { merge: false });
    let n = 0;
    while (store.undo()) n++;
    expect(n).toBe(3);
    expect(store.get(key)!.name).toBe('N2');
  });
});
