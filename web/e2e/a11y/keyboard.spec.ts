// P8.2, keyboard access (plan §11). Every test here uses the keyboard only: no clicks, no
// programmatic focus or selection (page.evaluate only reads state, waits for ProseMirror's focus
// timer, stubs window.print, or puts a throwaway element at the top of the page to start a Tab walk
// from there).
// - The walkthrough: create a brew, format text, insert a snippet, open the inspector and change a
//   class, set a section to 1 column, add and move a page object, edit the metadata, save and
//   print, checking where the focus goes and that it is visible at each stop.
// - Page objects (one behind the text too) and the inspector's objects list.
// - Panels, menus and dialogs: operating them, and the focus coming back where it was.
// - Page structure: skip link, landmarks, headings, toolbars and live regions on every route; the
//   save and layout announcements.
// The API is the in-memory fake (fakeApi.ts), so this runs anywhere.
//   E2E_PORT=5376 npx playwright test e2e/a11y/keyboard.spec.ts
import type { Editor } from '@tiptap/core';
import { expect, type Page, test } from '@playwright/test';
import { oversizeDoc, richDoc, TEXTS, trapDoc } from './docs';
import { ALICE, docOf, installFakeApi } from './fakeApi';
import { activeElement, BREW_CONTENT, focusIsVisible, focusOn, focusStop, LOAD_TIMEOUT, openEditor, tabUntil, waitForEditor, waitForPage } from './helpers';

type Active = Awaited<ReturnType<typeof activeElement>>;

/** The editor's document, as JSON. */
function docJson(page: Page): Promise<{ type: string; attrs?: Record<string, unknown>; content?: unknown[] }> {
  return page.evaluate(() => (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor.getJSON() as never);
}

/** Every node of the document (depth first), with its type, attributes, marks and text. */
async function nodes(page: Page): Promise<{ type: string; attrs: Record<string, unknown>; text: string; marks: string[] }[]> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor;
    const out: { type: string; attrs: Record<string, unknown>; text: string; marks: string[] }[] = [];
    editor.state.doc.descendants((node) => {
      out.push({ type: node.type.name, attrs: node.attrs, text: node.isText ? (node.text ?? '') : node.textContent, marks: node.marks.map((m) => m.type.name) });
      return true;
    });
    return out;
  });
}

/** Presses `key` in a roving toolbar until the focused item matches (at most `max` presses). */
async function rovingTo(page: Page, match: (a: Active) => boolean, key = 'ArrowRight', max = 60): Promise<Active> {
  for (let i = 0; i <= max; i++) {
    const active = await activeElement(page);
    if (match(active)) return active;
    await page.keyboard.press(key);
  }
  throw new Error(`no toolbar item matched after ${max} presses of ${key}; last: ${JSON.stringify(await activeElement(page))}`);
}

const byTestId = (id: string) => (a: Active) => a.testId === id;
const byName = (name: string | RegExp) => (a: Active) => (typeof name === 'string' ? a.name === name : name.test(a.name));

async function expectFocusVisible(page: Page, where: string) {
  expect(await focusIsVisible(page), `visible focus on ${where}: ${JSON.stringify(await activeElement(page))}`).toBe(true);
}

/**
 * The editor has the focus, and ProseMirror's follow-up to gaining it has run: 20 ms after the
 * focus event, prosemirror-view puts its selection back into the DOM if the DOM's differs from the
 * last one it read (handlers.focus), which undid a native caret move made before then (Ctrl+End
 * right after Escape returned the focus). A longer timer set after that one fires after it (timers
 * of a page fire in order of their due time).
 */
async function expectEditorFocused(page: Page) {
  await expect.poll(async () => (await activeElement(page)).editor, { message: 'the editor has the focus' }).toBe(true);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
}

test('keyboard only: create, format, insert, inspect, lay out, place an object, describe, save and print', async ({ page }) => {
  // One walkthrough (two editor routes, about forty keyboard steps): it can't be split.
  test.setTimeout(30_000);
  const api = await installFakeApi(page, { me: ALICE });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  await page.evaluate(() => {
    (window as unknown as { __hbPrints: number }).__hbPrints = 0;
    window.print = () => {
      (window as unknown as { __hbPrints: number }).__hbPrints += 1;
    };
  });

  // 1. The skip link comes first and shows; then the navbar's New → New brew.
  await page.keyboard.press('Tab');
  let active = await activeElement(page);
  expect(active.name).toBe('Skip to main content');
  await expectFocusVisible(page, 'the skip link');
  await tabUntil(page, byTestId('nav-new'));
  await expectFocusVisible(page, 'the New menu');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await activeElement(page)).name).toMatch(/^New brew/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/new$/, LOAD_TIMEOUT);
  await waitForEditor(page);
  // The caret is in the new brew (autoFocus).
  await expectEditorFocused(page);

  // 2. Type a heading and a paragraph.
  await page.keyboard.press('ControlOrMeta+Shift+1');
  await page.keyboard.type('Dragon Lair');
  await page.keyboard.press('Enter');
  await page.keyboard.type('The lair is dark and damp.');
  await expect.poll(async () => (await nodes(page)).filter((n) => n.type === 'heading').map((n) => n.text)).toEqual(['Dragon Lair']);

  // Saving creates the brew (POST), and the page becomes /edit/:editId with the same editor.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, LOAD_TIMEOUT);
  expect(api.log.some((l) => l.startsWith('POST /api/brews 201'))).toBe(true);
  await expectEditorFocused(page);

  // 3. Format: select "damp" with the keyboard; bold with Ctrl+B, italic from the toolbar.
  await page.keyboard.press('ArrowLeft'); // before the full stop
  await page.keyboard.press('ControlOrMeta+Shift+ArrowLeft'); // "damp"
  // The editor takes a selection the browser moved from its selectionchange, which Chromium sends a few ms after
  // the key events: Ctrl+B must not come first.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { state } = (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor;
        return state.doc.textBetween(state.selection.from, state.selection.to);
      }),
    )
    .toBe('damp');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('Alt+F10');
  active = await activeElement(page);
  expect(active.inPortal).toBe(false);
  expect(await page.getByTestId('editor-toolbar').evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await expectFocusVisible(page, 'the editing toolbar');
  await rovingTo(page, byTestId('mark-italic'));
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await nodes(page)).find((n) => n.type === 'text' && n.text === 'damp')?.marks.sort()).toEqual(['bold', 'italic']);
  // Escape goes back to the editor, with the selection where it was.
  await page.keyboard.press('Escape');
  await expectEditorFocused(page);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('damp');

  // 4. Insert a snippet from the Insert menu (search, Enter): one theme block, focus back in the text.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Alt+F10');
  await rovingTo(page, byTestId('insert-menu'));
  await page.keyboard.press('Enter');
  const search = page.getByRole('combobox', { name: /Search snippets/i });
  await expect(search).toBeFocused();
  await page.keyboard.type('note');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await nodes(page)).some((n) => n.type === 'themeBlock' && (n.attrs.classes as string[]).includes('note')), LOAD_TIMEOUT).toBe(true);
  await expectEditorFocused(page);

  // 5. The inspector: from the text, Shift+Tab reaches the brew toolbar; its Inspector toggle opens
  //    the panel. Its class field adds a class to the element at the caret (the note block's text).
  await tabUntil(page, (a) => a.testId === 'editor-app-bar' || a.testId?.startsWith('toggle-') === true || a.testId === 'print', { shift: true, max: 5 });
  await rovingTo(page, byTestId('toggle-inspector'));
  await expectFocusVisible(page, 'the Inspector toggle');
  const inspectorToggle = page.getByTestId('toggle-inspector');
  if ((await inspectorToggle.getAttribute('aria-expanded')) === 'true') {
    // Open by default: close it first (the toggle keeps the focus), then open it again.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inspector-panel')).toBeHidden();
    await expect(inspectorToggle).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector-panel')).toBeVisible();
  await expect(inspectorToggle).toHaveAttribute('aria-expanded', 'true');
  await tabUntil(page, (a) => a.role === 'tab');
  await rovingTo(page, byName('Element'), 'ArrowLeft', 2);
  await tabUntil(page, (a) => a.role === 'combobox' && a.name === 'Add class');
  await expectFocusVisible(page, 'the Add class field');
  await page.keyboard.type('wide');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await nodes(page)).some((n) => ((n.attrs.classes as string[] | undefined) ?? []).includes('wide'))).toBe(true);

  // 6. Page tab: the section goes to 1 column.
  await tabUntil(page, (a) => a.role === 'tab', { shift: true });
  await rovingTo(page, byName('Page'), 'ArrowRight', 2);
  await tabUntil(page, (a) => a.tag === 'select' && a.name === 'Columns');
  await expectFocusVisible(page, 'the Columns select');
  await page.keyboard.press('ArrowDown'); // Theme default → 1 column
  await expect.poll(async () => (await docJson(page)).content?.map((p) => (p as { attrs?: { columns?: unknown } }).attrs?.columns)[0]).toBe(1);

  // 7. A page object: Blocks menu → Add text object (edits at once), then move it with the arrows.
  await page.keyboard.press('Shift+Tab'); // back through the panel…
  await tabUntil(page, (a) => a.editor, { shift: true });
  await page.keyboard.press('Alt+F10');
  await rovingTo(page, byTestId('block-menu'));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  const addText = page.getByRole('menuitem', { name: 'Add text object' });
  for (let i = 0; i < 30 && !(await addText.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await expect(addText).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await activeElement(page)).name).toBe('Text object');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Chapter 1');
  await page.keyboard.press('Enter');
  const frame = page.getByTestId('object-frame');
  await expect(frame).toBeFocused();
  await expectFocusVisible(page, 'the object frame');
  const objectStyle = async () =>
    page.evaluate(() => {
      const editor = (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor;
      let style = '';
      editor.state.doc.forEach((pageNode) => {
        for (const o of (pageNode.attrs.objects as { text?: string; style?: string }[] | null) ?? []) if (o.text === 'Chapter 1') style = o.style ?? '';
      });
      return style;
    });
  const before = await objectStyle();
  const allObjects = await page.evaluate(() => {
    const editor = (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor;
    const out: unknown[] = [];
    editor.state.doc.forEach((pageNode) => out.push(pageNode.attrs.objects));
    return JSON.stringify(out);
  });
  expect(before, allObjects).toMatch(/left:\s*\d+px/);
  const px = (style: string, prop: string) => Number(new RegExp(`${prop}:\\s*(-?[\\d.]+)px`).exec(style)?.[1]);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(async () => [px(await objectStyle(), 'left') - px(before, 'left'), px(await objectStyle(), 'top') - px(before, 'top')]).toEqual([2, 10]);
  // Escape goes back to the text.
  await page.keyboard.press('Escape');
  await expectEditorFocused(page);

  // 8. Properties: from the brew toolbar; the title field, then Escape returns to the button.
  await tabUntil(page, (a) => a.testId?.startsWith('toggle-') === true || a.testId === 'print' || a.testId === 'open-properties', { shift: true, max: 5 });
  await rovingTo(page, byTestId('open-properties'));
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('metadata-dialog');
  await expect(dialog).toBeVisible();
  // It opens on its first field, the title.
  await expect.poll(async () => (await activeElement(page)).testId).toBe('meta-title');
  expect((await activeElement(page)).inPortal).toBe(true);
  await expectFocusVisible(page, 'the Title field');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('The Dragon Lair');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('open-properties')).toBeFocused();

  // 9. Save (Ctrl+S from the toolbar works too): the title and the edits reach the server.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByTestId('save-status-label')).toHaveText(/Saved/, LOAD_TIMEOUT);
  const stored = [...api.brews.values()].at(-1)!;
  expect(stored.title).toBe('The Dragon Lair');

  // 10. Print: Ctrl+P, and the Print button with Enter.
  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hbPrints: number }).__hbPrints)).toBe(1);
  await rovingTo(page, byTestId('print'), 'ArrowLeft');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hbPrints: number }).__hbPrints)).toBe(2);
});

/** The objects of every page: page index, id, kind and style. */
function objectsOf(page: Page): Promise<{ page: number; id: string; kind: string; style: string }[]> {
  return page.evaluate(() => {
    const editor = (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor;
    const out: { page: number; id: string; kind: string; style: string }[] = [];
    let index = 0;
    editor.state.doc.forEach((pageNode) => {
      for (const o of (pageNode.attrs.objects as { id: string; kind: string; style?: string }[] | null) ?? []) out.push({ page: index, id: o.id, kind: o.kind, style: o.style ?? '' });
      index += 1;
    });
    return out;
  });
}

/** A px length from a declaration list ('left: 12px; top: 3px;' → left = 12). */
const pxOf = (style: string, prop: string) => Number(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`).exec(style)?.[1]);

/** The text of the textblock that holds the editor's selection. */
function caretBlockText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor.state.selection.$from.parent.textContent);
}

/** From the text, Shift+Tab to the brew toolbar (panels, pages, print, properties). */
const toBrewBar = (page: Page) => tabUntil(page, (a) => a.testId === 'editor-app-bar' || /^toggle-|^print$|^open-|^page-/.test(a.testId ?? ''), { shift: true, max: 8 });

test('page objects from the keyboard: select one behind the text, move, resize, reorder, delete, undo; the inspector list', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openEditor(page, { doc: richDoc });
  await expectEditorFocused(page); // the edit page puts the caret into the brew

  // The image sits behind the text (5ePHB: z-index -1): the Blocks menu selects it.
  await page.keyboard.press('Alt+F10');
  await rovingTo(page, byTestId('block-menu'));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  const selectImage = page.getByRole('menuitem', { name: /^Select Image 1/ });
  for (let i = 0; i < 40 && !(await selectImage.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await expect(selectImage).toBeFocused();
  await page.keyboard.press('Enter');
  const frame = page.getByTestId('object-frame');
  await expect(frame).toBeFocused();
  await expect(frame).toHaveAttribute('aria-label', /^Image.*\(1 of 2\)/);
  await expectFocusVisible(page, 'the object frame');

  const image = async () => (await objectsOf(page)).find((o) => o.id === 'sketch')!;
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => pxOf((await image()).style, 'left')).toBeGreaterThan(0);
  const moved = await image();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => pxOf((await image()).style, 'left') - pxOf(moved.style, 'left')).toBe(1);
  await expect(page.getByTestId('object-status')).toContainText(/Moved/);

  // Alt+ArrowRight resizes it (one pixel wider).
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(async () => pxOf((await image()).style, 'width')).toBeGreaterThan(0);
  const sized = await image();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(async () => pxOf((await image()).style, 'width') - pxOf(sized.style, 'width')).toBe(1);
  await expect(page.getByTestId('object-status')).toContainText(/Resized/);

  // Bring forward (Ctrl+]): it goes after the text object in the stacking order.
  expect((await objectsOf(page)).map((o) => o.id)).toEqual(['sketch', 'credit']);
  await page.keyboard.press('ControlOrMeta+BracketRight');
  await expect.poll(async () => (await objectsOf(page)).map((o) => o.id)).toEqual(['credit', 'sketch']);
  await expect(frame).toBeFocused();

  // Tab reaches the object's toolbar; its Delete button removes the object and the focus goes back
  // to the text. One undo brings the object back.
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await activeElement(page)).testId).toBe('object-toolbar');
  await expectFocusVisible(page, 'the object toolbar');
  await rovingTo(page, byName('Delete object'));
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await objectsOf(page)).map((o) => o.id)).toEqual(['credit']);
  await expectEditorFocused(page);
  await expect(page.getByTestId('object-status')).toContainText('Object deleted');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await objectsOf(page)).map((o) => o.id)).toEqual(['credit', 'sketch']);

  // The inspector's Page tab lists the page's objects; Enter selects one (the frame gets the focus).
  await toBrewBar(page);
  await rovingTo(page, byTestId('toggle-inspector'));
  if ((await page.getByTestId('toggle-inspector').getAttribute('aria-expanded')) !== 'true') await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector-panel')).toBeVisible();
  await tabUntil(page, (a) => a.role === 'tab');
  await rovingTo(page, byName('Page'), 'ArrowRight', 2);
  await expect(page.getByRole('tab', { name: 'Page' })).toHaveAttribute('aria-selected', 'true');
  const listed = await tabUntil(page, byTestId('inspector-object-credit'));
  expect(listed.tag).toBe('button');
  await expectFocusVisible(page, 'an object in the inspector list');
  await page.keyboard.press('Enter');
  await expect(frame).toBeFocused();
  await expect(frame).toHaveAttribute('aria-label', /^Text/);
  await page.keyboard.press('Escape');
  await expectEditorFocused(page);
});

test('menus, the outline and the page box: operated from the keyboard, the focus comes back', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openEditor(page, { doc: richDoc });
  await expectEditorFocused(page);

  // A toolbar menu: Escape closes it onto its button, a second Escape goes back to the text.
  await page.keyboard.press('Alt+F10');
  await rovingTo(page, byTestId('block-type'));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  expect((await activeElement(page)).role).toBe('menuitemradio');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.getByTestId('block-type')).toBeFocused();
  await page.keyboard.press('Escape');
  await expectEditorFocused(page);

  // The outline: open it from the brew toolbar, go to a heading, close it (focus → its toggle).
  await toBrewBar(page);
  await rovingTo(page, byTestId('toggle-outline'), 'ArrowLeft');
  const outlineToggle = page.getByTestId('toggle-outline');
  if ((await outlineToggle.getAttribute('aria-expanded')) === 'true') {
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('outline-panel')).toBeHidden();
  }
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('outline-panel')).toBeVisible();
  await expect(outlineToggle).toBeFocused();
  await tabUntil(page, (a) => a.tag === 'a' && a.name.includes('Bestiary') && a.testId !== 'editor-app');
  await expectFocusVisible(page, 'an outline entry');
  await page.keyboard.press('Enter');
  await expect.poll(() => caretBlockText(page)).toBe('Bestiary');
  await tabUntil(page, byName('Close outline'), { shift: true });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('outline-panel')).toBeHidden();
  await expect(outlineToggle).toBeFocused();

  // Page navigation: type a page number, then ArrowUp for the previous page.
  await rovingTo(page, byTestId('page-input'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('page-input')).toHaveValue('3');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('page-input')).toHaveValue('2');
  // Out of the page box again: it keeps its arrows, Home is the text start and ArrowLeft there
  // moves to Previous page.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('page-input')).not.toBeFocused();
});

test('the style drawer, a dialog and a toast: operated from the keyboard, the focus comes back', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openEditor(page, { doc: richDoc });
  await expectEditorFocused(page);

  // The style drawer: CSS typed in it restyles the pages; Escape then Tab leaves the CSS editor.
  await toBrewBar(page);
  await rovingTo(page, byTestId('toggle-style'), 'ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('style-panel')).toBeVisible();
  await tabUntil(page, (a) => a.name === 'Brew CSS');
  await expectFocusVisible(page, 'the CSS editor');
  await page.keyboard.type('.page h2 { color: rgb(1, 2, 3); }');
  await expect
    .poll(() => page.locator(`${BREW_CONTENT} h2`).first().evaluate((el) => getComputedStyle(el).color), LOAD_TIMEOUT)
    .toBe('rgb(1, 2, 3)');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  expect((await activeElement(page)).name).not.toBe('Brew CSS');
  await tabUntil(page, byName('Close style drawer'), { shift: true });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('style-panel')).toBeHidden();
  await expect(page.getByTestId('toggle-style')).toBeFocused();

  // A dialog: Local history closes with Escape onto its button.
  await rovingTo(page, byTestId('open-local-history'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('local-history')).toBeVisible();
  await expect.poll(async () => (await activeElement(page)).inPortal).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('local-history')).toBeHidden();
  await expect(page.getByTestId('open-local-history')).toBeFocused();

  // A toast from the navbar (copying the share link), reached with F8.
  await tabUntil(page, byTestId('nav-share'), { shift: true });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('nav-share-panel')).toBeVisible();
  await focusOn(page, byTestId('nav-share-copy'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('nav-share-panel')).toBeHidden();
  await expect(page.getByTestId('nav-share')).toBeFocused();
  // The toast list exists only while a toast shows, and this one waits for the clipboard write.
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/^(Share link copied|Couldn't copy the link)$/)).toBeVisible();
  await page.keyboard.press('F8');
  await expect.poll(async () => (await activeElement(page)).inPortal).toBe(true);
  expect((await activeElement(page)).name).toMatch(/^Notifications/);
});

// Every route, one test each: [name, path (own brew's edit id, their brew's share id), editor, signed in].
const STRUCTURE_ROUTES: [string, (own: string, theirs: string) => string, 'edit' | 'view' | null, boolean][] = [
  ['home', () => '/', 'edit', true],
  ['new brew', () => '/new', 'edit', true],
  ['edit page', (own) => `/edit/${own}`, 'edit', true],
  ['share page', (_own, theirs) => `/share/${theirs}`, 'view', true],
  ['account', () => '/account', null, true],
  ['sign in (signed out: a signed-in visitor is sent on)', () => '/login', null, false],
  ['not found', () => '/no/such/page', null, false],
];

for (const [name, pathOf, editor, signedIn] of STRUCTURE_ROUTES) {
  test(`structure: skip link, landmarks, one h1, named toolbars and live regions: ${name}`, async ({ page }) => {
    const api = await installFakeApi(page, { me: signedIn ? ALICE : null });
    const own = api.add({ doc: richDoc, title: 'My brew' });
    const theirs = api.add({ doc: docOf('Their text.'), title: 'Their brew', owner: 'bob' });
    const path = pathOf(own.editId, theirs.shareId);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    if (editor) await waitForEditor(page);
    else await waitForPage(page);

    const outline = await page.evaluate((brew) => {
      const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0 || el.closest('[class*=srOnly], [class*=hidden]') !== null;
      const chrome = (el: Element) => !el.closest(brew);
      const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(chrome);
      return {
        banner: [...document.querySelectorAll('header, [role=banner]')].filter((h) => !h.closest('main, aside, [role=dialog], section, article')).length,
        main: document.querySelectorAll('main, [role=main]').length,
        mainNav: document.querySelectorAll('nav[aria-label="Main"]').length,
        h1: headings.filter((h) => h.tagName === 'H1').map((h) => h.textContent?.trim()),
        levels: headings.filter(visible).map((h) => Number(h.tagName[1])),
        toolbars: [...document.querySelectorAll('[role=toolbar]')].filter((t) => !t.closest('[hidden]')).map((t) => t.getAttribute('aria-label') ?? ''),
        statuses: [...document.querySelectorAll('[role=status], [aria-live]')].map((el) => el.getAttribute('data-testid') ?? el.getAttribute('role') ?? ''),
      };
    }, BREW_CONTENT);
    expect(outline.banner, `${name}: one banner`).toBe(1);
    expect(outline.main, `${name}: one main`).toBe(1);
    expect(outline.mainNav, `${name}: the site navigation`).toBe(1);
    expect(outline.h1, `${name}: one h1`).toHaveLength(1);
    expect(outline.levels[0], `${name}: the h1 comes first`).toBe(1);
    for (let i = 1; i < outline.levels.length; i++) {
      expect(outline.levels[i]! - outline.levels[i - 1]!, `${name}: heading levels ${outline.levels.join(' ')}`).toBeLessThanOrEqual(1);
    }
    for (const label of outline.toolbars) expect(label, `${name}: toolbars are named`).not.toBe('');
    if (editor === 'edit') {
      expect(outline.toolbars, name).toEqual(expect.arrayContaining(['Editing', 'Brew']));
      expect(outline.statuses, `${name}: layout status`).toContain('layout-status-text');
      const hint = await page.locator('.hb-canvas .ProseMirror').getAttribute('aria-describedby');
      expect(hint, `${name}: the editor's keyboard hint`).toBeTruthy();
      await expect(page.locator(`[id="${hint}"]`)).toContainText('Alt+F10');
    }
    if (editor === 'view') {
      expect(outline.toolbars, name).toContain('Viewing');
      await expect(page.getByRole('region', { name: 'Pages' })).toHaveAttribute('tabindex', '0');
    }
    if (path.startsWith('/edit/')) expect(outline.statuses, `${name}: save status`).toContain('save-status-live');

    // The skip link is the first stop from the top of the page (editor pages put the caret into
    // the brew on load; from there Shift+Tab leads back up). It shows while focused and moves the
    // focus to <main>. A throwaway element at the start of <body> sets where the Tab walk starts.
    await page.evaluate(() => {
      const start = document.createElement('span');
      start.tabIndex = -1;
      start.id = 'a11y-tab-start';
      document.body.prepend(start);
      start.focus();
    });
    await page.keyboard.press('Tab');
    await page.evaluate(() => document.getElementById('a11y-tab-start')?.remove());
    const skip = await activeElement(page);
    expect(skip.name, `${name}: skip link first`).toBe('Skip to main content');
    const box = await page.evaluate(() => (document.activeElement as HTMLElement).getBoundingClientRect().toJSON() as DOMRect);
    expect(box.width * box.height, `${name}: the skip link shows`).toBeGreaterThan(100);
    await expectFocusVisible(page, `${name}: skip link`);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('main') !== null), { message: `${name}: skip → main` }).toBe(true);
  });
}

test('live regions: the save status speaks', async ({ page }) => {
  const { api, brew } = await openEditor(page, { doc: docOf(TEXTS.intro) });
  await expectEditorFocused(page);
  const live = page.getByTestId('save-status-live');
  await expect(live).toHaveText('');
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' More.');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(live).toHaveText(/^Saved at /, LOAD_TIMEOUT);
  expect(api.saves(brew.editId).length).toBeGreaterThan(0);
  // A failed save is announced too (with what to do).
  api.failSaves = true;
  await page.keyboard.type(' Again.');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(live).not.toHaveText(/^Saved at /, LOAD_TIMEOUT);
  await expect(live).not.toHaveText('');
});

test('live regions: the layout status speaks', async ({ page }) => {
  // Layout warnings: the polite status line carries the count.
  await openEditor(page, { doc: oversizeDoc, title: 'Tall' });
  await expect(page.getByTestId('layout-status-text')).toHaveText(/1 layout warning/);
  await expect(page.getByTestId('layout-status-text')).toHaveAttribute('role', 'status');
});

test('no keyboard trap: where Tab stays in the text (lists, tables), Alt+F10 still leaves it', async ({ page }) => {
  await openEditor(page, { doc: trapDoc });
  await expectEditorFocused(page); // the caret is in the first list item
  const where = () =>
    page.evaluate(() => {
      const { $from } = (window as unknown as { __hbEditorApp: { editor: Editor } }).__hbEditorApp.editor.state.selection;
      const types: string[] = [];
      for (let d = $from.depth; d > 0; d--) types.push($from.node(d).type.name);
      return { text: $from.parent.textContent, inList: types.includes('listItem'), inCell: types.includes('tableCell') || types.includes('tableHeader') };
    });
  expect(await where()).toMatchObject({ text: 'First item', inList: true });

  // In a list, Tab indents (the first item can't: the key is still the editor's).
  await page.keyboard.press('Tab');
  await expectEditorFocused(page);
  await page.keyboard.press('Alt+F10');
  await expect.poll(async () => page.getByTestId('editor-toolbar').evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expectEditorFocused(page);
  expect(await where()).toMatchObject({ text: 'First item', inList: true });

  // In a table, Tab goes from cell to cell.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await where()).inCell).toBe(true);
  const cell = (await where()).text;
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await where()).text).not.toBe(cell);
  expect((await where()).inCell).toBe(true);
  await expectEditorFocused(page);
  await page.keyboard.press('Alt+F10');
  await expect.poll(async () => page.getByTestId('editor-toolbar').evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expectEditorFocused(page);

  // Out of the table, Tab leaves the text for the panels (and Shift+Tab reaches the toolbars).
  await page.keyboard.press('ControlOrMeta+End');
  // The selection follows the browser's selectionchange, which Chromium sends after the key events: poll.
  await expect.poll(where).toMatchObject({ inList: false, inCell: false });
  await page.keyboard.press('Shift+Tab');
  await expect.poll(async () => (await activeElement(page)).editor).toBe(false);
  expect(await page.getByTestId('editor-app-bar').evaluate((el) => el.contains(document.activeElement))).toBe(true);
});

test('focus order follows the layout, one stop per toolbar, and every stop shows its focus', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openEditor(page, { doc: richDoc });
  // Start from the top of the page (see the structure test).
  await page.evaluate(() => {
    const start = document.createElement('span');
    start.tabIndex = -1;
    start.id = 'a11y-tab-start';
    document.body.prepend(start);
    start.focus();
  });
  const regions: string[] = [];
  const invisible: string[] = [];
  const toolbarStops: Record<string, number> = {};
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const stop = await focusStop(page); // where, and whether it shows (one round trip per stop)
    if (!stop) continue; // the browser's own UI (Firefox) or <body>
    if (stop.region === 'skip link' && regions.length > 0) break; // wrapped around
    if (regions.at(-1) !== stop.region) regions.push(stop.region);
    if (stop.region.startsWith('toolbar')) toolbarStops[stop.region] = (toolbarStops[stop.region] ?? 0) + 1;
    if (!stop.visible) invisible.push(`${stop.region}: ${stop.key}`);
  }
  await page.evaluate(() => document.getElementById('a11y-tab-start')?.remove());
  // Skip link, site navigation, the editing toolbar, the brew toolbar, the pages, then the inspector
  // on the right. (The TOC's links, brew content, are Tab stops after the text in Chromium only.)
  const order = regions.filter((r) => r !== 'brew');
  expect(order.slice(0, 5)).toEqual(['skip link', 'navbar', 'toolbar Editing', 'toolbar Brew', 'editor']);
  expect(order[5]).toMatch(/^panel Inspector/);
  expect(toolbarStops).toEqual({ 'toolbar Editing': 1, 'toolbar Brew': 1 });
  expect(invisible, 'Tab stops without a visible focus indicator').toEqual([]);
});
