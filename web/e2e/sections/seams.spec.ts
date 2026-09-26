// Seam editing (P4.7, plan §4.8) in the browser, Chromium and Firefox: a paragraph that
// pagination split across two pages behaves like one paragraph for Backspace, Delete, the arrow
// keys and Enter. The keys are real key presses; the reference is the same paragraph unsplit.
import type { Page } from '@playwright/test';
import { doc, expect, h, load, p, page as pg, section, settled, test, useHarness } from '../pagination/harness';

test.use({ harnessVariant: 'sections' });

interface Caret {
  text: string;
  offset: number;
  fragments: number;
  page: number;
  fragment: number;
}

/**
 * The caret's block and offset, once ProseMirror has read the DOM selection. A native caret move
 * reaches it through selectionchange, a task of its own: under load Firefox ran two animation
 * frames before it, and the reading lagged one key press behind. So wait until the model's head is
 * where the DOM's focus is.
 */
async function caret(page: Page): Promise<Caret> {
  await page.waitForFunction(
    () => {
      const view = window.__hbPagination.editor.view as unknown as { state: { selection: { head: number } }; posAtDOM(node: Node, offset: number): number };
      const sel = document.getSelection();
      if (!sel?.focusNode) return false;
      try {
        return view.posAtDOM(sel.focusNode, sel.focusOffset) === view.state.selection.head;
      } catch {
        return false; // outside the editor
      }
    },
    undefined,
    { polling: 'raf' },
  );
  return page.evaluate(() => window.__hbPagination.caretInBlock()!);
}

// Selecting (the harness's select focuses the editor synchronously) waits for ProseMirror's own
// follow-up when it gave the editor focus: 20 ms after the editor gains focus, prosemirror-view
// puts its selection back into the DOM if the DOM's differs from the last one it saw
// (handlers.focus). A native caret move (an arrow key) made before then, whose selectionchange
// ProseMirror had not read yet, was undone: under load, Firefox lost the first ArrowRight. A timer
// set after that one fires after it.

/** Loads a section whose page 1 is full: its last paragraph continues on page 2. */
async function splitParagraph(page: Page): Promise<{ text: string; seam: number }> {
  await load(page, section(2.3));
  const r = await page.evaluate(async () => {
    const api = window.__hbPagination;
    const hadFocus = (api.editor.view as unknown as { hasFocus(): boolean }).hasFocus();
    api.select(api.endOfPage(0));
    if (!hadFocus) await new Promise((resolve) => setTimeout(resolve, 30)); // see above
    return { pages: api.pages(), block: api.caretInBlock()! };
  });
  expect(r.pages[1]!.blocks[0]).toMatch(/^paragraph\(cont\)/);
  expect(r.block.fragments).toBe(2);
  return { text: r.block.text, seam: r.block.offset };
}

/** Puts the caret at `offset` in the split block (fragment 0 up to the seam, else fragment 1). */
async function placeAt(page: Page, offset: number, seam: number, side: 'head' | 'tail' = offset < seam ? 'head' : 'tail') {
  await page.evaluate(
    async ([o, s, where]) => {
      const api = window.__hbPagination;
      const hadFocus = (api.editor.view as unknown as { hasFocus(): boolean }).hasFocus();
      if (where === 'head') api.select(api.endOfPage(0) - (s - o));
      else api.select(api.blockPos(1, 0) + 1 + (o - s));
      if (!hadFocus) await new Promise((resolve) => setTimeout(resolve, 30)); // see splitParagraph
    },
    [offset, seam, side] as const,
  );
}

/** The same keys on the paragraph unsplit (pagination off, one page): its text and caret after. */
async function unsplit(page: Page, text: string, offset: number, keys: string[]): Promise<{ text: string; offset: number }> {
  await page.evaluate(
    ([t]) => {
      const api = window.__hbPagination;
      api.setPaginate(false);
      api.load({ type: 'doc', content: [{ type: 'page', attrs: { columns: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] }] });
    },
    [text] as const,
  );
  await page.evaluate((o) => window.__hbPagination.select(2 + o), offset);
  for (const key of keys) await page.keyboard.press(key);
  const r = await caret(page);
  await page.evaluate(() => window.__hbPagination.setPaginate(true));
  return { text: r.text, offset: r.offset };
}

test.beforeEach(async ({ page }) => {
  await useHarness(page, { sections: true });
});

test('Backspace at the start of the continuation deletes the character before the seam, as in one paragraph', { tag: '@smoke' }, async ({ page }) => {
  const { text, seam } = await splitParagraph(page);
  await placeAt(page, seam, seam, 'tail');
  expect(await caret(page)).toMatchObject({ offset: seam, fragment: 1 });
  await page.keyboard.press('Backspace');
  await settled(page);
  const after = await caret(page);
  expect(after.text).toBe(text.slice(0, seam - 1) + text.slice(seam));
  expect(after.offset).toBe(seam - 1);
  // Twice more: still one character each.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await settled(page);
  const three = await caret(page);
  expect(three.text).toBe(text.slice(0, seam - 3) + text.slice(seam));
  expect(await page.evaluate(() => window.__hbPagination.overflowing())).toEqual([]);
  // The unsplit paragraph does the same.
  expect(await unsplit(page, text, seam, ['Backspace', 'Backspace', 'Backspace'])).toEqual({ text: three.text, offset: three.offset });
  // One undo step per key press.
  await load(page, section(2.3));
  await placeAt(page, seam, seam, 'tail');
  await page.keyboard.press('Backspace');
  await settled(page);
  await page.keyboard.press('Control+z');
  await settled(page);
  expect((await caret(page)).text).toBe(text);
});

test('Delete at the end of the fragment before the seam deletes the first character after it', async ({ page }) => {
  const { text, seam } = await splitParagraph(page);
  await placeAt(page, seam, seam, 'head');
  await page.keyboard.press('Delete');
  await settled(page);
  const after = await caret(page);
  expect(after.text).toBe(text.slice(0, seam) + text.slice(seam + 1));
  expect(after.offset).toBe(seam);
  expect(await unsplit(page, text, seam, ['Delete'])).toEqual({ text: after.text, offset: after.offset });
});

test('Ctrl+Backspace and Ctrl+Delete at the seam delete a word, as the browser does in one paragraph (PGR-7)', async ({ page }) => {
  const { text, seam } = await splitParagraph(page);
  await placeAt(page, seam, seam, 'tail');
  await page.keyboard.press('Control+Backspace');
  await settled(page);
  const back = await caret(page);
  expect(back.text.length).toBeLessThan(text.length);
  // One undo step.
  await page.keyboard.press('Control+z');
  await settled(page);
  expect((await caret(page)).text).toBe(text);
  // Ctrl+Delete at the end of the first fragment.
  await placeAt(page, seam, seam, 'head');
  await page.keyboard.press('Control+Delete');
  await settled(page);
  const forward = await caret(page);
  expect(forward.text.length).toBeLessThan(text.length);
  // The browser's own word delete in the same paragraph, unsplit.
  expect(await unsplit(page, text, seam, ['Control+Backspace'])).toEqual({ text: back.text, offset: back.offset });
  expect(await unsplit(page, text, seam, ['Control+Delete'])).toEqual({ text: forward.text, offset: forward.offset });
});

test('ArrowRight and ArrowLeft move one character per press across the seam (Shift extends)', async ({ page }) => {
  const { seam } = await splitParagraph(page);
  await placeAt(page, seam - 3, seam);
  const right: number[] = [];
  for (let k = 0; k < 6; k++) {
    await page.keyboard.press('ArrowRight');
    right.push((await caret(page)).offset);
  }
  expect(right).toEqual([seam - 2, seam - 1, seam, seam + 1, seam + 2, seam + 3]);
  const left: number[] = [];
  for (let k = 0; k < 6; k++) {
    await page.keyboard.press('ArrowLeft');
    left.push((await caret(page)).offset);
  }
  expect(left).toEqual([seam + 2, seam + 1, seam, seam - 1, seam - 2, seam - 3]);
  // Shift+ArrowRight from the end of the first fragment selects the seam's next character.
  await placeAt(page, seam, seam, 'head');
  await page.keyboard.press('Shift+ArrowRight');
  const selected = await page.evaluate(() => {
    const { state } = window.__hbPagination.editor as unknown as { state: { selection: { from: number; to: number }; doc: { textBetween(a: number, b: number): string } } };
    return state.doc.textBetween(state.selection.from, state.selection.to);
  });
  expect(selected.length).toBe(1);
});

test('Enter at the seam splits the paragraph there: no empty paragraph, the text after it is a paragraph of its own', { tag: '@smoke' }, async ({ page }) => {
  const { text, seam } = await splitParagraph(page);
  await placeAt(page, seam, seam, 'head');
  await page.keyboard.press('Enter');
  await settled(page);
  const after = await caret(page);
  expect(after).toMatchObject({ text: text.slice(seam), offset: 0, fragments: 1 });
  const texts = await page.evaluate(() => window.__hbPagination.texts().flat());
  expect(texts).toContain(text.slice(0, seam));
  expect(texts).not.toContain('');
  const reference = await unsplit(page, text, seam, ['Enter']);
  expect(reference).toEqual({ text: text.slice(seam), offset: 0 });
});

test('Backspace at the start of a page whose first block is whole joins it with the block before (joinBackward)', async ({ page }) => {
  // One-line paragraphs never split: every page starts with a whole paragraph.
  await load(page, doc(pg([h(1, 'Chapter'), ...Array.from({ length: 160 }, (_, i) => p(`Short line ${i}.`))], { pid: 'section1' })));
  const r = await page.evaluate(() => {
    const api = window.__hbPagination;
    const pages = api.pages();
    const texts = api.texts();
    api.select(api.blockPos(1, 0) + 1);
    return { first: pages[1]!.blocks[0]!, before: texts[0]!.at(-1)!, start: texts[1]![0]!, lines: api.flowText().split('\n').length };
  });
  expect(r.first).toMatch(/^paragraph:Short line/); // not a continuation
  await page.keyboard.press('Backspace');
  await settled(page);
  const after = await page.evaluate(() => ({ flow: window.__hbPagination.flowText().split('\n'), overflowing: window.__hbPagination.overflowing(), caret: window.__hbPagination.caretInBlock() }));
  expect(after.flow).toContain(`${r.before}${r.start}`);
  expect(after.flow).toHaveLength(r.lines - 1);
  expect(after.caret).toMatchObject({ text: `${r.before}${r.start}`, offset: r.before.length });
  expect(after.overflowing).toEqual([]);
  // One undo step gives both paragraphs back.
  await page.keyboard.press('Control+z');
  await settled(page);
  const undone = await page.evaluate(() => window.__hbPagination.flowText().split('\n'));
  expect(undone).toHaveLength(r.lines);
  expect(undone).toContain(r.before);
  expect(undone).toContain(r.start);
});

test('deleting the first fragment of a split paragraph leaves the rest a paragraph of its own', async ({ page }) => {
  const { text, seam } = await splitParagraph(page);
  const before = await page.evaluate(() => window.__hbPagination.flowText().split('\n'));
  expect(before).toContain(text);
  // Delete the whole first fragment (the node), as dragging it away or cutting it would.
  await page.evaluate(() => {
    const view = window.__hbPagination.editor.view as unknown as {
      state: { selection: { $head: { before(): number } }; doc: { nodeAt(p: number): { nodeSize: number } | null }; tr: { delete(a: number, b: number): unknown } };
      dispatch(tr: unknown): void;
    };
    const at = view.state.selection.$head.before();
    view.dispatch(view.state.tr.delete(at, at + view.state.doc.nodeAt(at)!.nodeSize));
  });
  await settled(page);
  const after = await page.evaluate(() => window.__hbPagination.flowText().split('\n'));
  // The paragraph became its second half, on its own line; nothing merged into the line before.
  expect(after).toHaveLength(before.length);
  const index = before.indexOf(text);
  expect(after[index]).toBe(text.slice(seam));
  expect(after[index - 1]).toBe(before[index - 1]);
});
