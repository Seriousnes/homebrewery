// Oversize warnings and the layout status (P4.8) in the browser: warnings appear and clear as the
// layout changes; each fix (allow splitting, make wide, shrink image) works on real theme CSS (the
// "Laying out pages…" indicator, on a fake clock: timing.spec.ts). /dev/sections, 5ePHB, both browsers.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { block, doc, expect, filler, h, load, p, page as pg, settled, test, useHarness } from '../pagination/harness';

test.use({ harnessVariant: 'sections' });

const oversized = (page: Page) => page.evaluate(() => window.__hbPagination.pages().filter((x) => x.oversized).map((x) => x.index));

/** A stat block taller than a column (but not than the page's two columns). */
const tallMonster = () => doc(pg([h(1, 'Bestiary'), block(['monster', 'frame'], [h(2, 'Ancient Dragon'), p(filler(4200, 1))]), p(filler(300, 2))], { pid: 'bestiary' }));

/** A paragraph holding an image taller than a column (an SVG with a known size, 400 × 1500). */
const tallImage = () => {
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1500"><rect width="400" height="1500" fill="#a33"/></svg>');
  return doc(
    pg(
      [
        h(1, 'Gallery'),
        { type: 'paragraph', content: [{ type: 'image', attrs: { src: `data:image/svg+xml,${svg}`, width: 400, height: 1500, style: 'width: 100%;' } }] },
        p(filler(300, 2)),
      ],
      { pid: 'gallery' },
    ),
  );
};

async function seriousViolations(page: Page): Promise<string[]> {
  // Legacy mode: axe.run in the page itself. The default mode finishes every run in a new blank
  // page, which in Firefox on a loaded machine took minutes (the a11y lane's finding, e2e/a11y/helpers.ts).
  const results = await new AxeBuilder({ page }).setLegacyMode(true).include('[data-testid="layout-status"]').include('[data-testid="layout-warnings-popover"]').analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test.beforeEach(async ({ page }) => {
  await useHarness(page, { sections: true });
});

test('a stat block taller than a column: the warning, keyboard access, "Allow splitting" clears it; undo brings it back', async ({ page }) => {
  await load(page, tallMonster());
  expect(await oversized(page)).toEqual([0]);
  await expect(page.locator('.ProseMirror > .page').first().locator('.hb-oversized-badge')).toBeVisible();
  const button = page.getByTestId('layout-warnings');
  await expect(button).toHaveText('1 layout warning');
  await expect(page.getByTestId('layout-status-text')).toHaveAttribute('role', 'status');
  // Keyboard: focus the button, open with Enter; focus moves into the dialog.
  await button.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByTestId('layout-warnings-popover');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByText(/Page 1:.*Theme block “monster frame” is taller than a column/)).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('[data-testid="layout-warnings-popover"]')!.contains(document.activeElement))).toBe(true);
  expect(await seriousViolations(page)).toEqual([]);
  // Escape closes it and gives focus back to the button.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  // The fix.
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Allow splitting' }).click();
  await expect(dialog).toBeHidden();
  await settled(page);
  expect(await oversized(page)).toEqual([]);
  await expect(button).toBeHidden();
  await expect(page.locator('.hb-oversized-badge')).toHaveCount(0);
  expect(await page.evaluate(() => window.__hbPagination.overflowing())).toEqual([]);
  // The block now flows over both columns of its page.
  const columns = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.ProseMirror .monster')!;
    return new Set(Array.from(el.getClientRects()).map((r) => Math.round(r.left))).size;
  });
  expect(columns).toBe(2);
  // One undo step: the block is whole again, and the warning is back.
  await page.evaluate(() => (window.__hbPagination.editor.view as unknown as { focus(): void }).focus());
  await page.keyboard.press('Control+z');
  await settled(page);
  expect(await oversized(page)).toEqual([0]);
  await expect(button).toBeVisible();
});

test('"Make wide" from the page\'s badge: the stat block spans the columns and fits', async ({ page }) => {
  await load(page, tallMonster());
  await page.locator('.hb-oversized-badge').first().click();
  const dialog = page.getByTestId('layout-warnings-popover');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Make wide' }).click();
  await settled(page);
  expect(await oversized(page)).toEqual([]);
  await expect(page.getByTestId('layout-warnings')).toBeHidden();
  expect(await page.evaluate(() => document.querySelector('.ProseMirror .monster')!.classList.contains('wide'))).toBe(true);
});

test('"Shrink image": an image taller than a column is made to fit', async ({ page }) => {
  await load(page, tallImage());
  expect(await oversized(page)).toHaveLength(1); // the image's page (it moved whole onto a fresh page)
  await page.getByTestId('layout-warnings').click();
  await page.getByTestId('layout-warnings-popover').getByRole('button', { name: 'Shrink image' }).click();
  await settled(page);
  expect(await oversized(page)).toEqual([]);
  const fit = await page.evaluate(() => {
    const img = document.querySelector<HTMLElement>('.ProseMirror img:not(.ProseMirror-separator)')!;
    const wrap = img.closest('.page')!.querySelector<HTMLElement>(':scope > div.columnWrapper')!;
    return { image: img.getBoundingClientRect().height, column: wrap.getBoundingClientRect().height, style: img.getAttribute('style') };
  });
  expect(fit.image).toBeLessThan(fit.column);
  expect(fit.style).toMatch(/width: \d+px/);
});
