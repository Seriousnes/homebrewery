import { Editor, type JSONContent } from '@tiptap/core';
import { undo, undoDepth } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { editorNodeViews } from '../nodeviews';
import { docOf, docWith, node, p, page, text } from '../schema/testing';
import { activeThemeBlockPos, toggleThemeBlockClassTr } from './commands';
import { canFrame, humanizeClass, themeBlockLabel } from './labels';
import { focusThemeBlockControls, themeBlockOverlayOf } from './overlay';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

function mount(content: JSONContent): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  editor = new Editor({ element, extensions: buildEditorExtensions({ extensions: editorNodeViews }), content });
  return editor;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const monster = node('themeBlock', { classes: ['monster', 'frame'] }, [
  node('heading', { level: 2 }, [text('Goblin')]),
  p('Small humanoid'),
  node('horizontalRule'),
  node('definitionList', undefined, [node('definitionTerm', undefined, [text('AC')]), node('definitionDesc', undefined, [text('15')])]),
]);

describe('labels', () => {
  it('names blocks from their classes', () => {
    expect(themeBlockLabel(['monster', 'frame'])).toBe('Stat block');
    expect(themeBlockLabel(['wide', 'note'])).toBe('Note');
    expect(themeBlockLabel(['classTable', 'frame', 'decoration', 'wide'])).toBe('Class table');
    expect(themeBlockLabel(['spellList'])).toBe('Spell list');
    expect(themeBlockLabel(['descriptive'])).toBe('Descriptive');
    expect(themeBlockLabel(['quote'])).toBe('Quote');
    expect(themeBlockLabel(['artist'])).toBe('Artist');
    expect(themeBlockLabel(['wide'])).toBe('Wide block');
    expect(themeBlockLabel([])).toBe('Block');
    expect(themeBlockLabel(['imageMaskEdge3'])).toBe('Image mask edge 3');
    expect(humanizeClass('homebrewery_credit-box')).toBe('Homebrewery credit box');
  });

  it('offers the frame toggle where the theme has a frame', () => {
    expect(canFrame(['monster'])).toBe(true);
    expect(canFrame(['classTable'])).toBe(true);
    expect(canFrame(['note'])).toBe(false);
    expect(canFrame(['note', 'frame'])).toBe(true);
  });
});

describe('ThemeBlockNodeView', () => {
  it('renders what renderHTML renders, with only the content as children', () => {
    const e = mount(docWith(p('x'), node('themeBlock', { classes: ['monster', 'frame'], style: 'color: red;', id: 'gob', attributes: { 'data-x': '1' } }, monster.content)));
    const block = e.view.dom.querySelector<HTMLElement>('div.block')!;
    expect(block.className).toBe('block monster frame');
    expect(block.getAttribute('style')).toBe('color: red;');
    expect(block.id).toBe('gob');
    expect(block.getAttribute('data-x')).toBe('1');
    expect([...block.children].map((c) => c.localName)).toEqual(['h2', 'p', 'hr', 'dl']);
    expect(block.firstElementChild?.textContent).toBe('Goblin');
  });

  it('patches the element in place when a toggle changes its classes (one undo step)', async () => {
    const e = mount(docWith(p('x'), monster));
    await flush(); // heading ids are assigned after init
    const pos = e.state.doc.firstChild!.firstChild!.nodeSize + 1;
    const before = e.view.dom.querySelector('div.block')!;
    const heading = before.querySelector('h2')!;
    const depth = Number(undoDepth(e.state));
    e.view.dispatch(toggleThemeBlockClassTr(e.state, pos, 'wide')!);
    const after = e.view.dom.querySelector('div.block')!;
    expect(after).toBe(before);
    expect(after.querySelector('h2')).toBe(heading);
    expect(after.className).toBe('block monster frame wide');
    expect(undoDepth(e.state)).toBe(depth + 1);
    e.view.dispatch(toggleThemeBlockClassTr(e.state, pos, 'frame')!);
    expect(after.className).toBe('block monster wide');
    expect(undoDepth(e.state)).toBe(depth + 2);
    undo(e.state, e.view.dispatch);
    expect(after.className).toBe('block monster frame wide');
    undo(e.state, e.view.dispatch);
    expect(after.className).toBe('block monster frame');
    expect(toggleThemeBlockClassTr(e.state, pos, 'frame', true)).toBeNull();
    // A selected block keeps ProseMirror's selection class through a toggle.
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, pos)));
    expect(after.classList.contains('ProseMirror-selectednode')).toBe(true);
    e.view.dispatch(toggleThemeBlockClassTr(e.state, pos, 'wide')!);
    expect(after.classList.contains('ProseMirror-selectednode')).toBe(true);
    expect(after.className).toBe('block monster frame wide ProseMirror-selectednode');
    expect(toggleThemeBlockClassTr(e.state, 0, 'wide')).toBeNull();
  });

  it('finds the innermost theme block around the selection', () => {
    const inner = node('themeBlock', { classes: ['note'] }, [p('inside note')]);
    const e = mount(docWith(node('themeBlock', { classes: ['wide'] }, [p('outer'), inner]), p('after')));
    let notePos = -1;
    let textPos = -1;
    e.state.doc.descendants((n, pos) => {
      if (n.type.name === 'themeBlock' && (n.attrs.classes as string[]).includes('note')) notePos = pos;
      if (n.isText && n.text === 'inside note') textPos = pos;
    });
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, textPos + 2)));
    expect(activeThemeBlockPos(e.state)).toBe(notePos);
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, notePos)));
    expect(activeThemeBlockPos(e.state)).toBe(notePos);
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, e.state.doc.content.size - 2)));
    expect(activeThemeBlockPos(e.state)).toBeNull();
  });
});

describe('theme block overlay', () => {
  it('shows the label while the selection is in a block and the editor has focus; Shift+Alt+F10 focuses it', async () => {
    const e = mount(docOf(page([p('before'), monster, p('after')])));
    const overlay = themeBlockOverlayOf(e.view)!;
    expect(overlay.store.getSnapshot().visible).toBe(false);

    let goblin = -1;
    e.state.doc.descendants((n, pos) => {
      if (n.isText && n.text === 'Goblin') goblin = pos;
    });
    e.view.focus();
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, goblin + 1)));
    const snapshot = overlay.store.getSnapshot();
    expect(snapshot.visible).toBe(true);
    expect(snapshot.block).toMatchObject({ label: 'Stat block', classes: ['monster', 'frame'], frameable: true });

    await flush();
    const controls = document.querySelector<HTMLElement>('[data-testid="theme-block-controls"]')!;
    expect(controls).not.toBeNull();
    expect(controls.querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe('Stat block block');
    const [wide, frame] = [...controls.querySelectorAll('button')];
    expect(wide?.textContent).toBe('Wide');
    expect(wide?.getAttribute('aria-pressed')).toBe('false');
    expect(frame?.getAttribute('aria-pressed')).toBe('true');

    // A click toggles the class (one undo step).
    wide!.click();
    await flush();
    expect(e.view.dom.querySelector('div.block')?.className).toBe('block monster frame wide');
    expect(document.querySelector('[data-testid="theme-block-controls"] button')?.getAttribute('aria-pressed')).toBe('true');

    // Shift+Alt+F10 moves focus into the controls; Escape back to the editor.
    expect(focusThemeBlockControls(e.view)).toBe(true);
    await flush();
    const first = document.querySelector<HTMLElement>('[data-testid="theme-block-controls"] button')!;
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(e.view.hasFocus()).toBe(true);
    // Tab returns to the text as well.
    expect(focusThemeBlockControls(e.view)).toBe(true);
    await flush();
    expect(document.activeElement?.closest('[data-testid="theme-block-controls"]')).not.toBeNull();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await flush();
    expect(e.view.hasFocus()).toBe(true);

    // Leaving the block hides it.
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 3)));
    expect(overlay.store.getSnapshot().visible).toBe(false);
    expect(focusThemeBlockControls(e.view)).toBe(false);
  });

  it('stays hidden in a read-only editor', () => {
    const e = mount(docOf(page([monster])));
    e.setEditable(false);
    e.view.focus();
    e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, 4)));
    expect(themeBlockOverlayOf(e.view)!.store.getSnapshot().visible).toBe(false);
  });
});
