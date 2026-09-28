// The "Text style" menu (T1) at /dev/toolbar, in Chromium and Firefox: every item previews its style
// in the active theme (the preview's h1 is the canvas's h1), the theme boxes follow the theme,
// and choosing a style is one undo step.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { blockOf, openToolbar, select, undoDepth } from './helpers';

const menu = (page: Page) => page.getByRole('menu', { name: 'Block type' });

async function openStyles(page: Page, text: string): Promise<Locator> {
  await select(page, text, 1);
  await page.getByTestId('block-type').click();
  await expect(menu(page)).toBeVisible();
  return menu(page);
}

/** Computed style properties of the first element `selector` matches in `root`. */
const computed = (root: Locator, selector: string, props: string[]) =>
  root.locator(selector).first().evaluate((el, names) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n)]));
  }, props);

test('5ePHB: items preview their style as the canvas shows it; the theme boxes are offered', async ({ page }) => {
  await openToolbar(page, { theme: '5ePHB' });
  const styles = await openStyles(page, 'Guests may');
  const names = await styles.getByRole('menuitemradio').evaluateAll((items) => items.map((i) => i.getAttribute('aria-label')));
  expect(names).toEqual(['Paragraph', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Code block', 'Definition list']);
  const boxes = await styles.getByRole('menuitemcheckbox').evaluateAll((items) => items.map((i) => i.getAttribute('aria-label')));
  expect(boxes).toEqual(['Blockquote', 'Note', 'Descriptive text box', 'Quote']);

  // Heading 1 looks like the canvas's heading 1 (font and colour); the note like the canvas's note.
  const canvas = page.locator('.hb-canvas .pages');
  const props = ['font-family', 'color', 'font-weight'];
  const previewH1 = await computed(styles.getByRole('menuitemradio', { name: 'Heading 1' }), '[data-hb-theme-preview] h1', props);
  expect(previewH1).toEqual(await computed(canvas, 'h1', props));
  expect(previewH1['font-family']).toContain('MrEavesRemake');
  const noteProps = ['background-color', 'font-family', 'border-image-source'];
  expect(await computed(styles.getByRole('menuitemcheckbox', { name: 'Note' }), '[data-hb-theme-preview] .note', noteProps)).toEqual(await computed(canvas, '.note', noteProps));

  // The page itself is gone: no page size, background or footer accent; rows stay menu-sized.
  const pageBox = await computed(styles.getByRole('menuitemradio', { name: 'Paragraph' }), '[data-hb-theme-preview] > .page', ['background-image', 'column-count', 'padding-top']);
  expect(pageBox).toEqual({ 'background-image': 'none', 'column-count': 'auto', 'padding-top': '0px' });
  for (const height of await styles.locator('[role^=menuitem]').evaluateAll((items) => items.map((i) => i.getBoundingClientRect().height))) {
    expect(height).toBeLessThan(90);
  }
  // The checked item is the selection's style.
  await expect(styles.getByRole('menuitemradio', { name: 'Paragraph' })).toHaveAttribute('aria-checked', 'true');
});

test('Blank: no theme boxes; Blockquote still offered', async ({ page }) => {
  await openToolbar(page, { theme: 'Blank' });
  const styles = await openStyles(page, 'Guests may');
  await expect(styles.getByRole('menuitemcheckbox')).toHaveCount(1);
  await expect(styles.getByRole('menuitemcheckbox', { name: 'Blockquote' })).toBeVisible();
});

test('choosing styles from the keyboard and the pointer: one undo step each', async ({ page }) => {
  await openToolbar(page, { theme: '5ePHB' });
  await openStyles(page, 'Guests may');
  const depth = await undoDepth(page);
  // Typeahead: "D" goes to Definition list.
  await page.keyboard.press('d');
  await expect(menu(page).getByRole('menuitemradio', { name: 'Definition list' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeHidden();
  expect((await blockOf(page, 'Guests may')).type).toBe('definitionTerm');
  await expect(page.getByTestId('block-type')).toHaveAccessibleName('Block type: Definition list');
  expect(await undoDepth(page)).toBe(depth + 1);

  const styles = await openStyles(page, 'Guests may');
  await styles.getByRole('menuitemcheckbox', { name: 'Note' }).click();
  expect((await blockOf(page, 'Guests may')).ancestors).toContain('themeBlock');
  const boxes = await openStyles(page, 'Guests may');
  await expect(boxes.getByRole('menuitemcheckbox', { name: 'Note' })).toHaveAttribute('aria-checked', 'true');
  await boxes.getByRole('menuitemcheckbox', { name: 'Descriptive text box' }).click();
  expect(await undoDepth(page)).toBe(depth + 3);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  const back = await blockOf(page, 'Guests may');
  expect([back.type, back.ancestors.includes('themeBlock')]).toEqual(['paragraph', false]);
});
