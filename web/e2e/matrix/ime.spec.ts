// §4.11 row 11 in the app's editor (/edit): IME composition at the end of a full page. Pagination
// restructures nothing while the author composes (the composed text may overflow the page for a
// moment); at compositionend it moves the overflowing line on, the caret with it.
//
// Chromium: a real composition through the DevTools protocol (Input.imeSetComposition and
// Input.insertText fire the same composition and input events an OS IME does). Both browsers
// (Firefox has no such protocol): the composition events an IME sends, dispatched to the editor,
// with the composed text written into the DOM between them as an IME does.
import type { Page } from '@playwright/test';
import { events, expect, expectClean, flowText, openEditor, pages, sectionDoc, select, settled, stepsOf, test, texts, watchErrors } from './helpers';

// Long enough to wrap onto a new line at the end of the full page.
const KANA = 'にほんごのぶんしょうをにゅうりょくしています'; // 22 characters
const KANJI = '日本語の文章を入力しています、長い文章が次の頁へ移ります'; // the "converted" commit

/** Lets `n` animation frames pass (pagination runs in requestAnimationFrame). */
const frames = (page: Page, n = 6) =>
  page.evaluate(async (count) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, n);

/** What pagination did (or didn't) while a composition is open. */
async function duringComposition(page: Page) {
  await frames(page);
  return page.evaluate(() => {
    const api = window.__hbPagination;
    return {
      composing: api.editor.view.composing,
      pages: api.pages().length,
      overflowOnPage1: api.domTruth(0)!.overflow,
      steps: api.events().filter((e) => e.kind === 'step').length,
    };
  });
}

async function openFullPage(page: Page) {
  const errors = watchErrors(page);
  await openEditor(page, { doc: sectionDoc(2.3) });
  const before = { pages: (await pages(page)).length, texts: await texts(page), flow: await flowText(page) };
  const end = await page.evaluate(() => window.__hbPagination.endOfPage(0));
  await select(page, end);
  await events(page); // an empty log from here
  return { errors, before, end };
}

/** After compositionend: pagination moved the line on, the caret followed, nothing overflows. */
async function expectSettledAfter(page: Page, committed: string, before: { flow: string }) {
  await settled(page);
  const actions = stepsOf(await events(page)).map((s) => s.action);
  expect(actions).toContain('push'); // the composed line moved on only now
  const after = await page.evaluate(() => {
    const api = window.__hbPagination;
    return { composing: api.editor.view.composing, overflowing: api.overflowing(), caret: api.caretInBlock(), selection: api.selection() };
  });
  expect(after.composing).toBe(false);
  expect(after.overflowing).toEqual([]);
  expect(after.caret!.text.slice(0, after.caret!.offset).endsWith(committed)).toBe(true);
  expect(after.selection.page).toBe(1); // the caret went with its line to page 2
  // The text is where the caret was: at the end of page 1's last paragraph (now split).
  const flow = await flowText(page);
  expect(flow.replace(committed, '')).toBe(before.flow);
}

test('a real IME composition (CDP) at the end of a full page: no restructuring until it ends', { tag: '@smoke' }, async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Input.imeSetComposition is a Chromium DevTools protocol command');
  const { errors, before } = await openFullPage(page);
  const cdp = await page.context().newCDPSession(page);
  for (let k = 1; k <= KANA.length; k += 3) {
    const text = KANA.slice(0, k);
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await cdp.send('Input.imeSetComposition', { text: KANJI, selectionStart: KANJI.length, selectionEnd: KANJI.length });
  const during = await duringComposition(page);
  expect(during).toEqual({ composing: true, pages: before.pages, overflowOnPage1: true, steps: 0 });

  await cdp.send('Input.insertText', { text: KANJI }); // commit: compositionend
  await expectSettledAfter(page, KANJI, before);
  await expectClean(page, errors);

  // Undo takes the composed text out again (one or two history steps), and the layout of before.
  for (let k = 0; k < 2 && JSON.stringify(await texts(page)) !== JSON.stringify(before.texts); k++) {
    await page.keyboard.press('ControlOrMeta+z');
    await settled(page);
  }
  expect(await texts(page)).toEqual(before.texts);
  await expectClean(page, errors);
});

test('composition events at the end of a full page: no restructuring until compositionend', async ({ page }) => {
  const { errors, before, end } = await openFullPage(page);
  // compositionstart, then the text the IME writes into the DOM with its compositionupdate and
  // input events, a few characters at a time.
  await page.evaluate((pos) => {
    const view = window.__hbPagination.editor.view as unknown as {
      dom: HTMLElement;
      domAtPos(pos: number): { node: Node; offset: number };
    };
    view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const at = view.domAtPos(pos);
    let text: Text;
    let offset: number;
    if (at.node.nodeType === Node.TEXT_NODE) {
      text = at.node as Text;
      offset = at.offset;
    } else {
      const before = at.node.childNodes[at.offset - 1];
      if (before?.nodeType === Node.TEXT_NODE) {
        text = before as Text;
        offset = text.length;
      } else {
        text = document.createTextNode('');
        at.node.insertBefore(text, at.node.childNodes[at.offset] ?? null);
        offset = 0;
      }
    }
    (window as unknown as { __hbIme: { text: Text; offset: number } }).__hbIme = { text, offset };
  }, end);
  let composed = '';
  for (let k = 0; k < KANA.length; k += 4) {
    const chunk = KANA.slice(k, k + 4);
    await page.evaluate(
      ([add, sofar]) => {
        const ime = (window as unknown as { __hbIme: { text: Text; offset: number } }).__hbIme;
        const view = window.__hbPagination.editor.view as unknown as { dom: HTMLElement };
        view.dom.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: false, inputType: 'insertCompositionText', data: sofar, isComposing: true }));
        ime.text.insertData(ime.offset, add);
        ime.offset += add.length;
        const sel = document.getSelection()!;
        sel.collapse(ime.text, ime.offset);
        view.dom.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: sofar }));
        view.dom.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: sofar, isComposing: true }));
      },
      [chunk, (composed += chunk)] as const,
    );
    const during = await duringComposition(page);
    expect(during.composing).toBe(true);
    expect(during.steps, `pagination steps while composing "${composed}"`).toBe(0);
    expect(during.pages).toBe(before.pages);
  }
  // By now the composed text needs a new line: page 1 overflows, and pagination leaves it alone.
  expect((await duringComposition(page)).overflowOnPage1).toBe(true);

  await page.evaluate((data) => {
    const view = window.__hbPagination.editor.view as unknown as { dom: HTMLElement };
    view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data }));
  }, composed);
  await expectSettledAfter(page, composed, before);
  await expectClean(page, errors);
});
