// Style drawer (P3.6) on /dev/inspector: brew CSS typed in CodeMirror restyles the canvas once
// typing pauses for userCssDelayMs, in one new stylesheet, then repaginates; Prettier formatting
// (keys and button, one undo step, errors), the snippet slot, theme class completion, keyboard
// exit and axe.
import { expect, type Page, type TestInfo } from '@playwright/test';
import { pauseClock } from '../clock';
import { block, chromeViolations, IDS, mod, openInspector, settled, test, transitionsDone } from './helpers';

/**
 * useCanvasTheme.ts USER_CSS_DELAY_MS (the e2e project can't import app sources): brew CSS applies
 * this long after its last edit.
 */
const USER_CSS_DELAY_MS = 150;

const editorBox = (page: Page) => page.getByRole('textbox', { name: 'Brew CSS' });

/** Replaces the Style editor's text (as an edit, reported to the canvas). */
async function setCss(page: Page, css: string): Promise<void> {
  await page.evaluate((text) => {
    const view = window.__hbInspector!.style()!.view as { dispatch: (spec: unknown) => void; state: { doc: { length: number } } };
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, css);
}

/** The Style editor's text. */
function cssText(page: Page): Promise<string> {
  return page.evaluate(() => window.__hbInspector!.style()!.getValue());
}

/** The intro paragraph's computed colour. */
const introColor = (page: Page) =>
  page.evaluate((testId) => getComputedStyle(document.querySelector(`.hb-canvas [data-testid="${testId}"]`)!).color, IDS.intro);

/** Repaginations the canvas requested for brew CSS. */
const cssRepaginations = (page: Page) => page.evaluate(() => window.__hbInspector!.repaginations.filter((r) => r.reason === 'css').length);

/** Stylesheets built from brew CSS that mentions data-testid (cssScope.ts scopeCss: one per apply), counted by addSheetCounter. */
const sheetsBuilt = (page: Page) => page.evaluate(() => (window as unknown as { __hbSheets: number }).__hbSheets);

async function addSheetCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __hbSheets: number };
    w.__hbSheets = 0;
    const proto = CSSStyleSheet.prototype;
    const replaceSync = Object.getOwnPropertyDescriptor(proto, 'replaceSync')!.value as (this: CSSStyleSheet, text: string) => void;
    proto.replaceSync = function (this: CSSStyleSheet, text: string) {
      if (text.includes('data-testid')) w.__hbSheets += 1;
      replaceSync.call(this, text);
    };
  });
}

/** Waits until the page has rendered with `css` (so the canvas's debounce of it is set). */
async function cssCommitted(page: Page, css: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__hbInspector!.committedCss)).toBe(css);
}
/** Waits until the canvas is ready: an apply that started has finished (and scheduled its repagination). */
const canvasReady = (page: Page) =>
  expect.poll(() => page.evaluate(() => (window.__hbInspector!.editor.storage as { hbCanvas?: { ready?: boolean } }).hbCanvas?.ready === true)).toBe(true);

/**
 * Reports the real time from the debounce firing to the restyle the test saw (its polling
 * included): never asserted (plan P3.6: CSS edits apply within 300 ms; the delay is 150 ms of it).
 */
function report(testInfo: TestInfo, applyMs: number[]): void {
  testInfo.annotations.push({ type: 'css apply ms after the debounce', description: applyMs.join(', ') });
  console.log(`[style.spec] ${testInfo.project.name}: debounce fired → canvas restyled (seen) in ${applyMs.map((ms) => `${ms} ms`).join(', ')}`);
}

// The page's clock is paused while the tests edit (e2e/clock.ts): the debounce and the
// repagination fire when the test moves the clock to them, however slow the machine.
test('typed CSS restyles the canvas userCssDelayMs after the last key, in one new stylesheet, then repaginates', async ({ page }, testInfo) => {
  await page.clock.install();
  await addSheetCounter(page);
  await openInspector(page);
  await settled(page);
  const editor = editorBox(page);
  await editor.click();
  await pauseClock(page);
  const repaginationsBefore = await cssRepaginations(page);
  const sheetsBefore = await sheetsBuilt(page);

  // Every edit restarts the debounce, so nothing applies until it has run from the last one. The
  // start of the rule comes in one edit (as pasted), the rest is typed key by key.
  const css = '.page [data-testid="p-intro"] { color: rgb(1, 2, 3) }';
  await setCss(page, css.slice(0, -8));
  await page.keyboard.press('Control+End');
  // A short delay per key: Firefox under load drops keys typed into CodeMirror at full speed.
  await page.keyboard.type(css.slice(-8), { delay: 15 });
  expect(await cssText(page)).toBe(css);
  await cssCommitted(page, css);
  await page.clock.runFor(USER_CSS_DELAY_MS - 1);
  expect(await introColor(page), 'restyled before the delay').not.toBe('rgb(1, 2, 3)');
  expect(await sheetsBuilt(page), 'stylesheets before the delay').toBe(sheetsBefore);
  await page.clock.runFor(1);
  const started = Date.now();
  await expect(block(page, IDS.intro)).toHaveCSS('color', 'rgb(1, 2, 3)');
  const applyMs = [Date.now() - started];
  // One stylesheet for all the typing (a missing debounce would build one per key).
  expect(await sheetsBuilt(page), 'stylesheets for the typed CSS').toBe(sheetsBefore + 1);

  // Then one repagination, from page 0 (its delay, 300 ms after the last edit, is
  // EditorCanvas.test.tsx's). With the clock running again: the canvas waits for fonts first, with
  // a timeout of its own.
  expect(await cssRepaginations(page), 'repaginated with the restyle').toBe(repaginationsBefore);
  await page.clock.resume();
  await expect.poll(() => cssRepaginations(page)).toBe(repaginationsBefore + 1);
  expect(await page.evaluate(() => window.__hbInspector!.repaginations.at(-1))).toEqual({ from: 0, reason: 'css' });
  await settled(page);
  report(testInfo, applyMs);
});

test('each edit of a value in place restyles the canvas userCssDelayMs after it, in one new stylesheet', async ({ page }, testInfo) => {
  await page.clock.install();
  await addSheetCounter(page);
  await openInspector(page);
  const css = '.page [data-testid="p-intro"] { color: rgb(1, 2, 3) }';
  await setCss(page, css);
  await expect(block(page, IDS.intro)).toHaveCSS('color', 'rgb(1, 2, 3)');
  await canvasReady(page);
  await settled(page);
  await pauseClock(page);
  const sheetsBefore = await sheetsBuilt(page);
  const applyMs: number[] = [];
  // Four edits, each changing one value in place (as when adjusting a colour).
  for (const [i, color] of ['rgb(4, 5, 6)', 'rgb(7, 8, 9)', 'rgb(10, 11, 12)', 'rgb(13, 14, 15)'].entries()) {
    const text = await cssText(page);
    const previous = /rgb\(\d+, \d+, \d+\)/.exec(text)![0];
    const at = text.indexOf(previous);
    await page.evaluate(
      ({ from, to, insert }) => {
        const view = window.__hbInspector!.style()!.view as { dispatch: (spec: unknown) => void };
        view.dispatch({ changes: { from, to, insert } });
      },
      { from: at, to: at + previous.length, insert: color },
    );
    await cssCommitted(page, text.replace(previous, color));
    await page.clock.runFor(USER_CSS_DELAY_MS - 1);
    expect(await introColor(page), `edit ${i + 1}: restyled before the delay`).toBe(previous);
    expect(await sheetsBuilt(page), `edit ${i + 1}: stylesheets before the delay`).toBe(sheetsBefore + i);
    await page.clock.runFor(1);
    const t0 = Date.now();
    await expect(block(page, IDS.intro)).toHaveCSS('color', color);
    applyMs.push(Date.now() - t0);
    expect(await sheetsBuilt(page), `edit ${i + 1}: stylesheets`).toBe(sheetsBefore + 1 + i);
  }
  await page.clock.resume();
  await settled(page);
  report(testInfo, applyMs);
});

test('Ctrl+Shift+F formats with Prettier as one undo step; Alt+Shift+F too', async ({ page, browserName }) => {
  await openInspector(page);
  await setCss(page, '.page{margin:0;padding:0} .note{color:red}');
  await editorBox(page).click();
  await page.keyboard.press('Control+Shift+F');
  await expect.poll(() => cssText(page)).toBe('.page {\n  margin: 0;\n  padding: 0;\n}\n.note { color: red; }\n');
  await expect(page.getByTestId('style-status')).toHaveText('CSS formatted.');
  await page.keyboard.press(`${mod(browserName)}+z`);
  await expect.poll(() => cssText(page)).toBe('.page{margin:0;padding:0} .note{color:red}');
  // Only the selection: the second rule.
  await page.evaluate(() => {
    const view = window.__hbInspector!.style()!.view as { dispatch: (spec: unknown) => void; state: { doc: { length: number } } };
    view.dispatch({ selection: { anchor: '.page{margin:0;padding:0} '.length, head: view.state.doc.length } });
  });
  await page.keyboard.press('Alt+Shift+F');
  await expect.poll(() => cssText(page)).toBe('.page{margin:0;padding:0} .note { color: red; }');
});

test('the Format button reports CSS Prettier cannot read, and changes nothing', async ({ page }) => {
  await openInspector(page);
  await setCss(page, '.page {\n  color: red;\n');
  const before = await cssText(page);
  await page.getByRole('button', { name: 'Format' }).click();
  await expect(page.getByTestId('style-status')).toHaveText(/Can’t format: .*\(line \d+/);
  expect(await cssText(page)).toBe(before);
});

test('snippet slot inserts at the cursor; theme classes are completed after a dot', async ({ page }) => {
  await openInspector(page);
  await page.getByTestId('style-snippets').click();
  await page.getByRole('menuitem', { name: 'Page background' }).click();
  await expect.poll(() => cssText(page)).toContain('background: #fdf6e3;');
  await expect(editorBox(page)).toBeFocused();
  await expect(page.locator('.hb-canvas .page').first()).toHaveCSS('background-color', 'rgb(253, 246, 227)');

  await page.keyboard.press('Control+End');
  await page.keyboard.type('.mons', { delay: 15 });
  const completion = page.locator('.cm-tooltip-autocomplete');
  await expect(completion).toBeVisible();
  await expect(completion.getByRole('option', { name: /^monster/ }).first()).toBeVisible();
  await page.waitForTimeout(200); // CodeMirror ignores Enter for 75 ms after the list opens (interactionDelay)
  await page.keyboard.press('Enter');
  await expect.poll(() => cssText(page)).toMatch(/\.monster$/);
});

test('keyboard: Tab indents, Esc then Tab leaves the editor', async ({ page }) => {
  await openInspector(page);
  const editor = editorBox(page);
  await editor.click();
  await page.keyboard.type('a');
  await page.keyboard.press('Tab');
  expect(await cssText(page)).toBe('a\t');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
});

test.describe('axe', () => {
  test('style drawer with text, status and completion, light and dark', async ({ page }) => {
    await openInspector(page, { scheme: 'light' });
    await page.evaluate(() => {
      const view = window.__hbInspector!.style()!.view as { dispatch: (spec: unknown) => void };
      view.dispatch({ changes: { from: 0, insert: '.page{color:rgb(20,20,20)}\n/* note */\n@media print{.wide{margin:0}}' } });
    });
    await page.getByRole('button', { name: 'Format' }).click();
    await expect(page.getByTestId('style-status')).toHaveText('CSS formatted.');
    expect(await chromeViolations(page)).toEqual([]);
    await editorBox(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('.fr', { delay: 15 });
    await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
    expect(await chromeViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.getByTestId('scheme-select').selectOption('dark');
    await expect(page.getByTestId('style-editor')).toHaveAttribute('data-scheme', 'dark');
    await transitionsDone(page);
    expect(await chromeViolations(page)).toEqual([]);
  });
});
