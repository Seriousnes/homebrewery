// Style drawer (P3.6) on /dev/inspector: brew CSS typed in CodeMirror restyles the canvas within
// 300 ms (measured from the edit to the computed style), then repaginates; Prettier formatting
// (keys and button, one undo step, errors), the snippet slot, theme class completion, keyboard
// exit and axe.
import { expect, type Page } from '@playwright/test';
import { block, chromeViolations, IDS, mod, openInspector, settled, test, transitionsDone } from './helpers';

/** Budget from the plan (P3.6 "CSS edits apply within 300 ms"): the median of the samples. */
const BUDGET_MS = 300;
/**
 * No single sample may take twice the budget. Single samples are noisy on a loaded machine (timers
 * fire late); a missing debounce or a full re-render would show up here.
 */
const SAMPLE_LIMIT_MS = 2 * BUDGET_MS;

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

/**
 * Starts watching (every frame) for the intro paragraph's computed colour to become `color`;
 * resolves with the time from the last CSS edit the drawer reported to that frame.
 */
function watchApplied(page: Page, color: string): Promise<number> {
  return page.evaluate(
    ({ testId, color }) =>
      new Promise<number>((resolve, reject) => {
        const probe = document.querySelector<HTMLElement>(`.hb-canvas [data-testid="${testId}"]`)!;
        const started = performance.now();
        const tick = () => {
          const now = performance.now();
          if (getComputedStyle(probe).color === color) resolve(now - window.__hbInspector!.lastCssEdit);
          else if (now - started > 10_000) reject(new Error(`colour never became ${color}`));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { testId: IDS.intro, color },
  );
}

test('typed CSS restyles the canvas within 300 ms, then repaginates', async ({ page }, testInfo) => {
  await openInspector(page);
  const repaginationsBefore = await page.evaluate(() => window.__hbInspector!.repaginations.filter((r) => r.reason === 'css').length);
  const editor = editorBox(page);
  await editor.click();

  // Real typing: the budget runs from the last keystroke that changed the CSS.
  const applied = watchApplied(page, 'rgb(1, 2, 3)');
  // A short delay per key: Firefox under load drops keys typed into CodeMirror at full speed.
  await page.keyboard.type('.page [data-testid="p-intro"] { color: rgb(1, 2, 3) }', { delay: 15 });
  const typedMs = await applied;
  expect(await cssText(page)).toBe('.page [data-testid="p-intro"] { color: rgb(1, 2, 3) }');
  await expect(block(page, IDS.intro)).toHaveCSS('color', 'rgb(1, 2, 3)');

  // Repagination follows the CSS (debounced), from page 0.
  await expect
    .poll(() => page.evaluate(() => window.__hbInspector!.repaginations.filter((r) => r.reason === 'css').length))
    .toBeGreaterThan(repaginationsBefore);
  const last = await page.evaluate(() => window.__hbInspector!.repaginations.at(-1));
  expect(last).toEqual({ from: 0, reason: 'css' });
  await settled(page);

  // Three more edits, each changing one value in place (as when adjusting a colour).
  const samples = [typedMs];
  for (const [i, color] of ['rgb(4, 5, 6)', 'rgb(7, 8, 9)', 'rgb(10, 11, 12)', 'rgb(13, 14, 15)'].entries()) {
    const text = await cssText(page);
    const previous = /rgb\(\d+, \d+, \d+\)/.exec(text)![0];
    const at = text.indexOf(previous);
    const done = watchApplied(page, color);
    await page.evaluate(
      ({ from, to, insert }) => {
        const view = window.__hbInspector!.style()!.view as { dispatch: (spec: unknown) => void };
        view.dispatch({ changes: { from, to, insert } });
      },
      { from: at, to: at + previous.length, insert: color },
    );
    samples.push(await done);
    await page.waitForTimeout(100 * (i + 1));
  }
  testInfo.annotations.push({ type: 'css apply ms', description: samples.map((ms) => ms.toFixed(0)).join(', ') });
  console.log(`[style.spec] ${testInfo.project.name}: CSS edit → canvas restyled in ${samples.map((ms) => `${ms.toFixed(0)} ms`).join(', ')}`);
  const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
  expect(median).toBeLessThan(BUDGET_MS);
  for (const ms of samples) expect(ms).toBeLessThan(SAMPLE_LIMIT_MS);
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
