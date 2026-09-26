// §4.11 row 5 in the app's editor (/edit): an ordered list split across pages. The continuation
// list starts at the right number, and keeps doing so when items are added (Enter) or the edit is
// undone: the numbers the reader sees run 1, 2, 3 … across the seam with no gap or repeat.
import type { Page } from '@playwright/test';
import { doc, expect, expectClean, filler, h, li, ol, openEditor, p, pg, select, settled, test, watchErrors } from './helpers';

const ITEMS = 16;
const item = (i: number) => `Item ${i + 1}: ${filler(110, i)}`;

/** Paragraphs filling most of page 1, then an ordered list that runs onto page 2. */
const listDoc = () =>
  doc(
    pg(
      [
        h(1, 'Chapter One'),
        ...Array.from({ length: 6 }, (_, i) => p(filler(700, i))),
        ol(1, ...Array.from({ length: ITEMS }, (_, i) => li(item(i)))),
        p(filler(400, 7)),
      ],
      { pid: 'section1' },
    ),
  );

interface Fragment {
  page: number;
  /** the model's start attribute */
  start: number;
  continuation: boolean;
  /** the rendered <ol start> */
  domStart: number;
  /** per item: its text and whether it continues an item of the fragment before (no marker) */
  items: { text: string; continued: boolean }[];
}

/** Every fragment of the document's ordered list, in order, from the model and the DOM. */
function fragments(page: Page): Promise<Fragment[]> {
  return page.evaluate(() => {
    const { editor } = window.__hbPagination;
    const view = editor.view as unknown as { nodeDOM(pos: number): Node | null };
    const out: Fragment[] = [];
    const docNode = editor.state.doc as unknown as {
      forEach(f: (page: { forEach(g: (n: PMLike, offset: number) => void): void }, offset: number, index: number) => void): void;
    };
    type PMLike = { type: { name: string }; attrs: Record<string, unknown>; textContent: string; forEach(f: (n: PMLike) => void): void };
    docNode.forEach((pageNode, pagePos, index) => {
      pageNode.forEach((node, offset) => {
        if (node.type.name !== 'orderedList') return;
        const el = view.nodeDOM(pagePos + 1 + offset) as HTMLOListElement;
        const items: Fragment['items'] = [];
        node.forEach((n) => items.push({ text: n.textContent, continued: n.attrs.continuation === true }));
        out.push({ page: index, start: Number(node.attrs.start), continuation: node.attrs.continuation === true, domStart: el.start, items });
      });
    });
    return out;
  });
}

/** The numbers shown in front of the items (continued items show none), and each item's text. */
function numbering(list: Fragment[]): { shown: number[]; texts: string[] } {
  const shown: number[] = [];
  const texts: string[] = [];
  for (const f of list) {
    f.items.forEach((it, k) => {
      if (it.continued) texts[texts.length - 1] += it.text;
      else {
        shown.push(f.domStart + k);
        texts.push(it.text);
      }
    });
  }
  return { shown, texts };
}

async function expectContinuousNumbering(page: Page, count: number, split = true): Promise<Fragment[]> {
  const list = await fragments(page);
  if (split) expect(list.length, 'the list is split across pages').toBeGreaterThanOrEqual(2);
  expect(list[0]!.continuation).toBe(false);
  expect(list[0]!.domStart).toBe(1);
  for (let k = 1; k < list.length; k++) {
    const [head, cont] = [list[k - 1]!, list[k]!];
    expect(cont.page).toBe(head.page + 1);
    expect(cont.continuation).toBe(true);
    // head.start + items on the head's page, minus one when the head's last item continues here.
    expect(cont.start).toBe(head.start + head.items.length - (cont.items[0]!.continued ? 1 : 0));
    expect(cont.domStart, 'the rendered <ol start>').toBe(cont.start);
  }
  const { shown } = numbering(list);
  expect(shown).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  return list;
}

test('an ordered list split across pages continues its numbering, through Enter and undo', { tag: '@smoke' }, async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: listDoc() });
  const before = await expectContinuousNumbering(page, ITEMS);
  expect(numbering(before).texts).toEqual(Array.from({ length: ITEMS }, (_, i) => item(i)));
  await expectClean(page);

  // Enter at the end of item 2, then a new item's text: one more item before the seam.
  const at = await page.evaluate((text) => {
    const api = window.__hbPagination;
    return api.posOf(text) + text.length;
  }, item(1));
  await select(page, at);
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('A new item');
  await settled(page);
  const added = await expectContinuousNumbering(page, ITEMS + 1);
  expect(numbering(added).texts[2]).toBe('A new item');
  await expectClean(page);

  // Undo (the typing, then the Enter) brings back the list and its layout.
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page);
  let now = await fragments(page);
  if (numbering(now).shown.length !== ITEMS) {
    await page.keyboard.press('ControlOrMeta+z');
    await settled(page);
    now = await fragments(page);
  }
  await expectContinuousNumbering(page, ITEMS);
  expect(now).toEqual(before);
  await expectClean(page, errors);
});

test('a list pushed onto the next page item by item keeps counting', async ({ page }) => {
  const errors = watchErrors(page);
  await openEditor(page, { doc: listDoc() });
  const first = await fragments(page);
  expect(first.map((f) => f.page)).toEqual([0, 1]);
  // Type in the paragraph before the list, about two lines at a time: the seam moves up through the
  // list, one item (or line) after another, and the numbers stay continuous at every step, until
  // the whole list is on page 2 (starting at 1 again, no continuation).
  const start = await page.evaluate(() => window.__hbPagination.blockPos(0, 7) - 1); // end of the last paragraph before the list
  await select(page, start);
  const headCounts = new Set<number>();
  let whole = false;
  for (let k = 0; k < 30 && !whole; k++) {
    await page.keyboard.insertText(` ${filler(110, k + 3)}`);
    await settled(page);
    const list = await fragments(page);
    whole = list.length === 1;
    await expectContinuousNumbering(page, ITEMS, !whole);
    if (whole) {
      expect(list[0]).toMatchObject({ page: 1, start: 1, continuation: false });
    } else {
      expect(list.map((f) => f.page)).toEqual([0, 1]);
      headCounts.add(list[0]!.items.length);
    }
    await expectClean(page);
  }
  expect(whole, 'the list moved to page 2 as a whole').toBe(true);
  expect(headCounts.size, 'distinct seams seen while the list moved').toBeGreaterThanOrEqual(2);
  await expectClean(page, errors);
});
