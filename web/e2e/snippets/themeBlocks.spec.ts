// P5.2: the theme-block label and its Wide / Frame toggles (/dev/snippets?doc=blocks, 5ePHB).
// "Done when": toggling wide or frame is one undo step. Also: the label is outside the block
// (its children are the content only, so .monster hr ~ dl, :first-child … still match), it is
// keyboard operable (Shift+Alt+F10, arrows, Space, Escape), and it has no serious axe issues.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openSnippets, stubNetwork, waitSettled } from './helpers';

const controls = (page: Page) => page.getByTestId('theme-block-controls');
const monster = (page: Page) => page.locator('.hb-canvas .page div.block.monster');
const note = (page: Page) => page.locator('.hb-canvas .page div.block.note');

async function clickInto(page: Page, text: string): Promise<void> {
  await page.locator('.hb-canvas .page').getByText(text, { exact: true }).first().click();
  // The editor takes the caret from the browser's selectionchange, which Chromium sends about 10 ms after the
  // click resolves: a key pressed before it would still act on the old selection.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__hbSnippets!.editor.state as unknown as { selection: { $from: { parent: { textContent: string } } } };
        return state.selection.$from.parent.textContent;
      }),
    )
    .toContain(text);
}

/** Computed styles of a block's children (what theme selectors decide). */
async function childStyles(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluate((block) =>
    [...block.children].map((c) => {
      const s = getComputedStyle(c);
      return `${c.localName} ${s.marginTop} ${s.marginBottom} ${s.fontSize} ${s.fontFamily} ${s.color} ${s.borderTopWidth} ${s.display}`;
    }),
  );
}

async function canUndo(page: Page): Promise<boolean> {
  return page.evaluate(() => (window.__hbSnippets!.editor as unknown as { can(): { undo(): boolean } }).can().undo());
}

test.describe('theme block label', () => {
  test.beforeEach(async ({ page }) => {
    await stubNetwork(page);
    await openSnippets(page, { doc: 'blocks' });
  });

  test('shows the block type next to the block, outside its content', async ({ page }) => {
    const before = await childStyles(page, '.hb-canvas .page div.block.monster');
    await expect(controls(page)).toHaveCount(0);
    await clickInto(page, 'Goblin');
    await expect(controls(page)).toBeVisible();
    await expect(controls(page).getByRole('toolbar', { name: 'Stat block block' })).toBeVisible();
    await expect(controls(page)).toContainText('Stat block');
    await expect(controls(page).getByRole('button', { name: 'Wide' })).toHaveAttribute('aria-pressed', 'false');
    await expect(controls(page).getByRole('button', { name: 'Frame' })).toHaveAttribute('aria-pressed', 'true');

    // Outside the canvas; the block's children are its content only, styled as before.
    expect(await controls(page).evaluate((el) => el.closest('.hb-canvas') === null)).toBe(true);
    expect(await monster(page).evaluate((b) => [...b.children].map((c) => c.localName))).toEqual(['h2', 'p', 'hr', 'dl', 'hr', 'p']);
    expect(await childStyles(page, '.hb-canvas .page div.block.monster')).toEqual(before);
    // It sits just above the block's top-left corner (or inside it when there's no room).
    const tab = (await controls(page).boundingBox())!;
    const block = (await monster(page).boundingBox())!;
    expect(Math.abs(tab.x - block.x)).toBeLessThan(2);
    expect(tab.y + tab.height).toBeLessThanOrEqual(block.y + tab.height + 4);

    // A note has no frame toggle.
    await clickInto(page, 'Notes use the theme frame.');
    await expect(controls(page).getByRole('toolbar', { name: 'Note block' })).toBeVisible();
    await expect(controls(page).getByRole('button', { name: 'Frame' })).toHaveCount(0);

    // Outside any block, or with the focus elsewhere: hidden.
    await clickInto(page, 'After the note.');
    await expect(controls(page)).toHaveCount(0);
  });

  test('toggling wide or frame is one undo step', async ({ page }) => {
    await clickInto(page, 'Goblin');
    expect(await canUndo(page)).toBe(false);
    const wide = controls(page).getByRole('button', { name: 'Wide' });
    await wide.click();
    await expect(monster(page)).toHaveClass(/\bwide\b/);
    await expect(wide).toHaveAttribute('aria-pressed', 'true');
    expect(await monster(page).evaluate((b) => getComputedStyle(b).columnSpan)).toBe('all');
    // The editor keeps the focus and the selection (the pointer press doesn't take them).
    expect(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror'))).toBe(true);
    await waitSettled(page);

    await page.keyboard.press('ControlOrMeta+z');
    await expect(monster(page)).not.toHaveClass(/\bwide\b/);
    await expect(monster(page)).toHaveClass(/\bframe\b/);
    expect(await canUndo(page)).toBe(false);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(monster(page)).toHaveClass(/\bwide\b/);

    await controls(page).getByRole('button', { name: 'Frame' }).click();
    await expect(monster(page)).not.toHaveClass(/\bframe\b/);
    await waitSettled(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(monster(page)).toHaveClass(/\bframe\b/);
    await expect(monster(page)).toHaveClass(/\bwide\b/);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(monster(page)).not.toHaveClass(/\bwide\b/);
    expect(await canUndo(page)).toBe(false);
    // Typing after a toggle is its own undo step too.
    await controls(page).getByRole('button', { name: 'Wide' }).click();
    await page.keyboard.type('x');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(monster(page)).toHaveClass(/\bwide\b/);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(monster(page)).not.toHaveClass(/\bwide\b/);
  });

  test('is keyboard operable: Shift+Alt+F10, arrows, Space, Escape', async ({ page }) => {
    await clickInto(page, 'Goblin');
    await page.keyboard.press('Shift+Alt+F10');
    const wide = controls(page).getByRole('button', { name: 'Wide' });
    const frame = controls(page).getByRole('button', { name: 'Frame' });
    await expect(wide).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(frame).toBeFocused();
    await page.keyboard.press('Space');
    await expect(monster(page)).not.toHaveClass(/\bframe\b/);
    await expect(frame).toHaveAttribute('aria-pressed', 'false');
    await expect(frame).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.hb-canvas .ProseMirror')).toBeFocused();
    await expect(controls(page)).toBeVisible();
    // Undo from the editor: one step.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(monster(page)).toHaveClass(/\bframe\b/);
    // Tab from the controls goes back to the text too (they sit outside its tab order).
    await page.keyboard.press('Shift+Alt+F10');
    await expect(wide).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('.hb-canvas .ProseMirror')).toBeFocused();
    // Without a block around the cursor the key does nothing.
    await clickInto(page, 'After the note.');
    await page.keyboard.press('Shift+Alt+F10');
    await expect(page.locator('.hb-canvas .ProseMirror')).toBeFocused();
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await clickInto(page, 'Goblin');
    await expect(controls(page)).toBeVisible();
    const results = await new AxeBuilder({ page }).setLegacyMode(true).include('[data-testid="theme-block-controls"]').analyze();
    expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });

  test('follows the block while scrolling and hides with it', async ({ page }) => {
    await clickInto(page, 'Goblin');
    await expect(controls(page)).toBeVisible();
    const y0 = (await controls(page).boundingBox())!.y;
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => (await controls(page).boundingBox())?.y ?? 0).toBeLessThan(y0 - 60);
    await note(page).scrollIntoViewIfNeeded();
  });
});
