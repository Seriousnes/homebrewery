// The "Text style" menu model (textStyles.tsx): entries, checked state, theme boxes offered by the
// active theme's CSS, one undo step per item, and the previews' markup. The menu itself (keyboard,
// layout, axe) runs in web/e2e/toolbar.
import type { Editor, JSONContent } from '@tiptap/core';
import { undoDepth } from '@tiptap/pm/history';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MenuEntry, MenuItem } from '@/ui';
import { docOf, node, p, page, text } from '../../schema/testing';
import { createTestEditor, selectText } from './testing';
import { textStyleEntries, themeStyledBoxes } from './textStyles';

let editor: Editor | undefined;
let style: HTMLStyleElement | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  style?.remove();
  style = undefined;
});

const open = (...blocks: JSONContent[]) => (editor = createTestEditor(docOf(page(blocks, { pid: 'testpage' }))));
const items = (entries: MenuEntry[], group: string): MenuItem[] => {
  const found = entries.find((e) => e.type === 'group' && e.id === group);
  return found?.type === 'group' ? found.items.filter((i): i is MenuItem => i.type !== 'separator') : [];
};
const item = (entries: MenuEntry[], id: string): MenuItem => [...items(entries, 'text-style'), ...items(entries, 'text-box')].find((i) => i.id === id)!;
const select = (i: MenuItem) => {
  if (i.type === 'checkbox') i.onCheckedChange(!i.checked);
  else if (i.type !== 'submenu') i.onSelect();
};
const checked = (entries: MenuEntry[]) =>
  [...items(entries, 'text-style'), ...items(entries, 'text-box')].filter((i) => (i.type === 'checkbox' || i.type === 'radio') && i.checked).map((i) => i.id);

function themeCss(css: string): void {
  style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
}

describe('textStyleEntries', () => {
  it('lists every text style, then the boxes; checks the selection’s', () => {
    const e = open(node('heading', { level: 2 }, [text('Title')]), node('blockquote', {}, [p('quoted')]));
    selectText(e, 'Title', 1);
    const entries = textStyleEntries(e, e.state, { themeBoxes: [] });
    expect(items(entries, 'text-style').map((i) => i.label)).toEqual([
      'Paragraph',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
      'Heading 5',
      'Heading 6',
      'Code block',
      'Definition list',
    ]);
    expect(items(entries, 'text-box').map((i) => i.label)).toEqual(['Blockquote']);
    expect(checked(entries)).toEqual(['heading2']);
    expect(item(entries, 'heading2').shortcut).toBe('Ctrl+Shift+2');
    selectText(e, 'quoted', 1);
    expect(checked(textStyleEntries(e, e.state, { themeBoxes: [] }))).toEqual(['paragraph', 'blockquote']);
  });

  it('offers the theme boxes the active theme styles, and a box the selection is in', () => {
    const e = open(p('plain'), node('themeBlock', { classes: ['quote'] }, [p('inside')]));
    selectText(e, 'plain', 1);
    expect(themeStyledBoxes()).toEqual([]);
    expect(items(textStyleEntries(e), 'text-box').map((i) => i.id)).toEqual(['blockquote']);
    themeCss('.hb-canvas .page .note { padding: 1px } .hb-canvas .page .descriptive { padding: 1px } .app .quote { color: red }');
    expect(themeStyledBoxes()).toEqual(['note', 'descriptive']); // .app .quote is not canvas CSS
    expect(items(textStyleEntries(e), 'text-box').map((i) => i.label)).toEqual(['Blockquote', 'Note', 'Descriptive text box']);
    selectText(e, 'inside', 1);
    const entries = textStyleEntries(e);
    expect(items(entries, 'text-box').map((i) => i.id)).toEqual(['blockquote', 'note', 'descriptive', 'quote']);
    expect(checked(entries)).toEqual(['paragraph', 'quote']);
  });

  it('every item is one undo step and runs afterSelect', () => {
    const e = open(p('Str :: 18'));
    selectText(e, 'Str', 1);
    let after = 0;
    const entries = () => textStyleEntries(e, e.state, { themeBoxes: ['note'], afterSelect: () => (after += 1) });
    select(item(entries(), 'heading1'));
    expect(e.state.doc.child(0).child(0).type.name).toBe('heading');
    select(item(entries(), 'definitionList'));
    expect(e.state.doc.child(0).child(0).type.name).toBe('definitionList');
    select(item(entries(), 'note'));
    expect(e.state.doc.child(0).child(0).attrs.classes).toEqual(['note']);
    expect(checked(entries())).toEqual(['definitionList', 'note']);
    select(item(entries(), 'note'));
    expect(e.state.doc.child(0).child(0).type.name).toBe('definitionList');
    expect([Number(undoDepth(e.state)), after]).toEqual([4, 4]);
  });

  it('items preview the element the editor emits, inside .hb-canvas > .page; or show icons', () => {
    const e = open(p('x'));
    selectText(e, 'x', 1);
    const entries = textStyleEntries(e, e.state, { themeBoxes: ['note'] });
    const markup = (id: string) => {
      const { container, unmount } = render(item(entries, id).content as ReactElement);
      const root = container.firstElementChild!;
      const html = [root.className.includes('hb-canvas'), root.getAttribute('aria-hidden'), root.querySelector(':scope > .page')!.innerHTML];
      unmount();
      return html;
    };
    expect(markup('heading1')).toEqual([true, 'true', '<h1>Heading 1</h1>']);
    expect(markup('codeBlock')).toEqual([true, 'true', '<pre><code>Code block</code></pre>']);
    expect(markup('definitionList')).toEqual([true, 'true', '<dl><dt>Definition</dt><dd>list</dd></dl>']);
    expect(markup('blockquote')).toEqual([true, 'true', '<blockquote><p>Blockquote</p></blockquote>']);
    expect(markup('note')).toEqual([true, 'true', '<div class="block note"><p>Note</p></div>']);
    const plain = textStyleEntries(e, e.state, { themeBoxes: [], previews: false });
    expect([item(plain, 'heading1').content, item(plain, 'heading1').icon, item(plain, 'blockquote').icon]).toEqual([undefined, 'heading1', 'quote']);
  });
});
