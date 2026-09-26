// S1 go/no-go (c): IME composition in the canvas. Chromium only: the composition is driven
// through the DevTools protocol (Input.imeSetComposition / Input.insertText), which fires the
// same compositionstart/update/end and input events an OS IME does. Firefox has no CDP; its
// IME path needs a manual check (see the S1 report).
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { caret, openCanvas, paragraphRange, setCaret, settle } from './helpers';

test.use({ viewport: { width: 1400, height: 1300 } });

async function compose(cdp: CDPSession, steps: string[], commit: string): Promise<void> {
  for (const text of steps) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await cdp.send('Input.insertText', { text: commit });
}

function paragraphText(page: Page, testId: string): Promise<string> {
  return page.evaluate((id) => {
    let text = '';
    window.__editor!.state.doc.descendants((node) => {
      const attributes = node.attrs.attributes as Record<string, string> | undefined;
      if (attributes?.['data-testid'] === id) text = node.textContent;
    });
    return text;
  }, testId);
}

test.describe('S1 (c) IME input', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'IME is driven through CDP (Chromium only); Firefox IME needs a manual check');

  test('Japanese and Korean composition commit into the document at the caret', async ({ page }) => {
    await openCanvas(page);
    const cdp = await page.context().newCDPSession(page);
    const events: string[] = [];
    await page.evaluate(() => {
      const w = window as unknown as { __imeEvents: string[] };
      w.__imeEvents = [];
      for (const type of ['compositionstart', 'compositionend']) {
        window.__editor!.view.dom.addEventListener(type, () => w.__imeEvents.push(type));
      }
    });

    // Japanese: に → にほ → にほん → 日本 (conversion), committed as 日本, at the end of page 1.
    const last = await paragraphRange(page, 'page1-last');
    const before = await paragraphText(page, 'page1-last');
    await setCaret(page, last.to);
    await compose(cdp, ['に', 'にほ', 'にほん', '日本'], '日本');
    await settle(page);
    const composing = await page.evaluate(() => window.__editor!.view.composing);
    expect(composing).toBe(false);
    expect(await paragraphText(page, 'page1-last')).toBe(`${before}日本`);
    expect((await caret(page)).head).toBe(last.to + 2);

    // Korean: ㅎ → 하 → 한 (commit), then ㄱ → 구 → 국 (commit) → 한국, in the middle of a
    // paragraph that runs over the column boundary.
    const split = await paragraphRange(page, 'split-para');
    const splitBefore = await paragraphText(page, 'split-para');
    await setCaret(page, split.from + 7);
    await compose(cdp, ['ㅎ', '하', '한'], '한');
    await compose(cdp, ['ㄱ', '구', '국'], '국');
    await settle(page);
    expect(await paragraphText(page, 'split-para')).toBe(`${splitBefore.slice(0, 7)}한국${splitBefore.slice(7)}`);
    expect((await caret(page)).head).toBe(split.from + 9);

    events.push(...(await page.evaluate(() => (window as unknown as { __imeEvents: string[] }).__imeEvents)));
    expect(events.filter((e) => e === 'compositionstart').length).toBeGreaterThanOrEqual(3);
    expect(events.filter((e) => e === 'compositionend').length).toBeGreaterThanOrEqual(3);

    // The page structure is intact (no stray nodes, pages still hold only their flow).
    const shape = await page.evaluate(() => ({
      pages: document.querySelectorAll('.hb-canvas > .pages > .page').length,
      stray: document.querySelectorAll('.hb-canvas > .pages > :not(.page)').length,
      doc: window.__editor!.state.doc.childCount,
    }));
    expect(shape).toEqual({ pages: 2, stray: 0, doc: 2 });

    // Undo removes the Korean word as one or two steps and keeps the rest.
    await page.keyboard.press('Control+z');
    await settle(page);
    expect(await paragraphText(page, 'split-para')).not.toContain('국');
  });
});
