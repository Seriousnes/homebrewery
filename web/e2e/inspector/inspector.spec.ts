// Inspector (P3.5) on /dev/inspector with real theme CSS and pagination: edits reach the canvas,
// each is one undo step (Ctrl+Z in the canvas), invalid input is refused with an inline error,
// section settings repaginate, the objects list selects objects, keyboard operation and axe.
import { expect } from '@playwright/test';
import { block, chromeViolations, clickIn, focusCanvas, IDS, mod, openInspector, overflowing, pages, settled, test, transitionsDone } from './helpers';

test('class chips: a theme suggestion reaches the canvas; Ctrl+Z / Ctrl+Y in the canvas undo and redo it', async ({ page, browserName }) => {
  await openInspector(page);
  await clickIn(page, IDS.intro);
  await expect(page.getByTestId('inspector-target')).toHaveText('Paragraph');
  const box = page.getByRole('combobox', { name: 'Add class' });
  await box.click();
  await box.pressSequentially('wid');
  const list = page.getByRole('listbox', { name: 'Classes suggestions' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option', { name: 'wide', exact: true })).toBeVisible();
  // Arrow to "wide" and pick it with Enter.
  const options = await list.getByRole('option').allTextContents();
  for (let i = 0; i <= options.indexOf('wide'); i++) await box.press('ArrowDown');
  await expect(box).toHaveAttribute('aria-activedescendant', /.+/);
  await box.press('Enter');
  await expect(block(page, IDS.intro)).toHaveClass(/\bwide\b/);
  await expect(page.getByTestId('inspector-classes').getByText('wide', { exact: true })).toBeVisible();
  await expect(box).toBeFocused();

  await focusCanvas(page);
  await page.keyboard.press(`${mod(browserName)}+z`);
  await expect(block(page, IDS.intro)).not.toHaveClass(/\bwide\b/);
  await expect(page.getByTestId('inspector-classes').getByText('None')).toBeVisible();
  await page.keyboard.press(`${mod(browserName)}+y`);
  await expect(block(page, IDS.intro)).toHaveClass(/\bwide\b/);
});

test('invalid input is refused inline and changes nothing; valid style reaches the canvas', async ({ page }) => {
  await openInspector(page);
  await clickIn(page, IDS.intro);
  const docBefore = await page.evaluate(() => JSON.stringify(window.__hbInspector!.editor.getJSON()));

  const box = page.getByRole('combobox', { name: 'Add class' });
  await box.fill('columnWrapper');
  await box.press('Enter');
  await expect(box).toHaveAccessibleDescription(/added by the editor itself/);
  await expect(box).toHaveAttribute('aria-invalid', 'true');

  const style = page.getByRole('textbox', { name: 'Style' });
  await style.fill('colour: red');
  await style.press('Tab');
  await expect(style).toHaveAttribute('aria-invalid', 'true');
  await expect(style).toHaveAccessibleDescription(/Not valid CSS: “colour: red”/);
  await expect(page.getByTestId('inspector-announcer')).toContainText('Not valid CSS');

  const id = page.getByRole('textbox', { name: 'Id', exact: true });
  await id.fill('p2');
  await id.press('Enter');
  await expect(id).toHaveAccessibleDescription(/reserved: pages use the ids/);

  expect(await page.evaluate(() => JSON.stringify(window.__hbInspector!.editor.getJSON()))).toBe(docBefore);

  await style.fill('color: rgb(120, 20, 20); letter-spacing: 1px');
  await style.press('Control+Enter');
  await expect(style).not.toHaveAttribute('aria-invalid');
  await expect(block(page, IDS.intro)).toHaveCSS('color', 'rgb(120, 20, 20)');
  await expect(style).toHaveValue(/color: rgb\(120, 20, 20\);\s*letter-spacing: 1px;/);
});

test('breadcrumbs pick an ancestor: a class on the theme block', async ({ page }) => {
  await openInspector(page);
  await clickIn(page, IDS.note);
  const crumbs = page.getByRole('navigation', { name: 'Element path' });
  await expect(crumbs.getByRole('button')).toHaveText(['Theme block.note', 'Paragraph']);
  await crumbs.getByRole('button', { name: 'Theme block.note' }).click();
  await expect(page.getByTestId('inspector-target')).toHaveText('Theme block');
  await expect(crumbs.getByRole('button', { name: 'Theme block.note' })).toHaveAttribute('aria-current', 'true');
  const box = page.getByRole('combobox', { name: 'Add class' });
  await box.fill('wide');
  await box.press('Enter');
  const note = page.locator('.hb-canvas div.block.note');
  await expect(note).toHaveClass(/\bwide\b/);
  await expect(block(page, IDS.note)).not.toHaveClass(/\bwide\b/);
});

test('attributes and id reach the canvas DOM', async ({ page }) => {
  await openInspector(page);
  await clickIn(page, IDS.item);
  await expect(page.getByTestId('inspector-target')).toHaveText('Paragraph');
  await page.getByRole('navigation', { name: 'Element path' }).getByRole('button', { name: 'List item' }).click();
  const attrs = page.getByRole('group', { name: 'Attributes' });
  await attrs.getByRole('textbox', { name: 'Name' }).fill('data-mood');
  await attrs.getByRole('textbox', { name: 'Value' }).fill('grim');
  await attrs.getByRole('button', { name: 'Add attribute' }).click();
  await expect(page.locator('.hb-canvas li[data-mood="grim"]')).toHaveCount(1);
  const id = page.getByRole('textbox', { name: 'Id', exact: true });
  await id.fill('stairs');
  await id.press('Enter');
  await expect(page.locator('.hb-canvas li#stairs')).toHaveCount(1);
});

test('section settings: 1 column on every page of the section, repaginated; one undo step', async ({ page, browserName }) => {
  await openInspector(page);
  await clickIn(page, IDS.flow);
  await page.getByRole('tab', { name: 'Page' }).click();
  await expect(page.getByTestId('inspector-page-title')).toHaveText(/^Page 1 of \d+$/);
  const before = await pages(page);
  const sectionEnd = before.findIndex((a, i) => i > 0 && a.kind === 'manual');
  expect(sectionEnd).toBeGreaterThan(1); // the flow text made auto pages

  const repaginationsBefore = await page.evaluate(() => window.__hbInspector!.repaginations.length);
  await page.getByRole('combobox', { name: 'Columns' }).selectOption('1');
  await settled(page);
  const after = await pages(page);
  const firstManual = after.findIndex((a, i) => i > 0 && a.kind === 'manual');
  expect(after.slice(0, firstManual).every((a) => a.columns === 1)).toBe(true);
  expect(after.slice(firstManual).every((a) => a.columns === null)).toBe(true);
  await expect(page.locator('.hb-canvas .page.hb-cols-1')).toHaveCount(firstManual);
  // Pagination re-ran for the edit itself (not a CSS or theme repagination), and nothing overflows.
  expect(await page.evaluate(() => window.__hbInspector!.repaginations.length)).toBe(repaginationsBefore);
  expect(await overflowing(page)).toEqual([]);

  await focusCanvas(page);
  await page.keyboard.press(`${mod(browserName)}+z`);
  await settled(page);
  const undone = await pages(page);
  expect(undone.length).toBe(before.length);
  expect(undone.map((a) => a.columns)).toEqual(before.map((a) => a.columns));
  expect(await overflowing(page)).toEqual([]);
});

test('section style reflows the section: more pages, and fewer again after undo', async ({ page, browserName }) => {
  await openInspector(page);
  await clickIn(page, IDS.intro);
  await page.getByRole('tab', { name: 'Page' }).click();
  const before = await pages(page);
  const style = page.getByRole('textbox', { name: 'Section style' });
  await style.fill('font-size: 14pt; line-height: 1.6');
  await style.press('Control+Enter');
  await settled(page);
  const after = await pages(page);
  expect(after.length).toBeGreaterThan(before.length);
  const sectionEnd = after.findIndex((a, i) => i > 0 && a.kind === 'manual');
  expect(after.slice(0, sectionEnd).every((a) => typeof a.style === 'string' && a.style.includes('font-size'))).toBe(true);
  expect(await overflowing(page)).toEqual([]);
  await focusCanvas(page);
  await page.keyboard.press(`${mod(browserName)}+z`);
  await settled(page);
  expect((await pages(page)).length).toBe(before.length);
  expect(await overflowing(page)).toEqual([]);
});

test('page numbers and footer on every page of the section', async ({ page }) => {
  await openInspector(page);
  await clickIn(page, IDS.statName);
  await page.getByRole('tab', { name: 'Page' }).click();
  await expect(page.getByRole('switch', { name: /Page numbers/ })).not.toBeChecked();
  await page.getByRole('switch', { name: /Page numbers/ }).check();
  const footer = page.getByRole('textbox', { name: 'Footer' });
  await footer.fill('Bestiary | Inn Mimic');
  await footer.press('Enter');
  await settled(page);
  const all = await pages(page);
  const start = all.findIndex((a, i) => i > 0 && a.kind === 'manual');
  const end = all.findIndex((a, i) => i > start && a.kind === 'manual');
  const section = all.slice(start, end);
  expect(section.every((a) => a.pageNumber === true && a.footer === 'Bestiary | Inn Mimic')).toBe(true);
  const pageEls = page.locator('.hb-canvas .page');
  for (let i = start; i < end; i++) {
    await expect(pageEls.nth(i).locator('.footnote')).toHaveText('Bestiary | Inn Mimic');
    await expect(pageEls.nth(i).locator('.pageNumber')).toHaveCount(1);
  }
  await expect(pageEls.nth(end).locator('.footnote')).toHaveCount(0);
});

test('markers: cover type and counting on this page only', async ({ page }) => {
  await openInspector(page);
  await clickIn(page, IDS.second);
  await page.getByRole('tab', { name: 'Page' }).click();
  const cover = page.getByRole('combobox', { name: 'Cover' });
  await expect(cover).toHaveValue('backCover');
  await cover.selectOption('partCover');
  await page.getByRole('checkbox', { name: 'Skip this page when counting' }).check();
  const last = page.locator('.hb-canvas .page').last();
  await expect(last.locator('span.partCover')).toHaveCount(1);
  await expect(last.locator('span.backCover')).toHaveCount(0);
  await expect(last.locator('span.skipCounting')).toHaveCount(1);
  await expect(page.locator('.hb-canvas span.partCover')).toHaveCount(1);
});

test('objects: selecting one reaches the objects lane and its classes and style can be edited', async ({ page }) => {
  await openInspector(page);
  await clickIn(page, IDS.intro);
  await page.getByRole('tab', { name: 'Page' }).click();
  const objects = page.getByTestId('inspector-objects');
  await expect(objects.getByRole('button')).toHaveText(['Embedded image', 'Art: inn sketch.artist']);
  await objects.getByRole('button', { name: /Art: inn sketch/ }).click();
  await expect(objects.getByRole('button', { name: /Art: inn sketch/ })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__hbInspector!.selectedObjects)).toEqual([{ pageIndex: 0, id: 'credit' }]);
  // The objects lane selected it and its selection frame has focus (arrow keys move it).
  expect(await page.evaluate(() => window.__hbInspector!.selectedObject()?.id)).toBe('credit');
  await expect(page.locator('.hb-canvas [role=group]:focus')).toHaveCount(1);
  const box = page.getByRole('combobox', { name: 'Add object class' });
  await box.fill('watercolor1');
  await box.press('Enter');
  await expect(page.locator('.hb-canvas [data-object-id="credit"]')).toHaveClass(/\bwatercolor1\b/);
  const style = page.getByRole('textbox', { name: 'Object style' });
  await style.fill('position: absolute; bottom: 12px; right: 30px');
  await style.press('Control+Enter');
  await expect(page.locator('.hb-canvas [data-object-id="credit"]')).toHaveCSS('bottom', '12px');
});

test('keyboard: tabs, breadcrumbs, combobox and Escape without a mouse', async ({ page }) => {
  await openInspector(page);
  await clickIn(page, IDS.note);
  const tab = page.getByRole('tab', { name: 'Element' });
  await tab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Page' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Page' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Tab'); // the tab panel
  await expect(page.getByRole('tabpanel', { name: 'Element' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Theme block.note' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector-target')).toHaveText('Theme block');
  const box = page.getByRole('combobox', { name: 'Add class' });
  await box.focus();
  await page.keyboard.type('fr');
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('fr');
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('');
  // The style field: Escape reverts a draft.
  const style = page.getByRole('textbox', { name: 'Style' });
  await style.focus();
  await page.keyboard.type('color: red');
  await page.keyboard.press('Escape');
  await expect(style).toHaveValue('');
});

test.describe('axe', () => {
  test('inspector: element and page tabs, open suggestions, light and dark', async ({ page }) => {
    await openInspector(page, { style: false, scheme: 'light' });
    await clickIn(page, IDS.note);
    expect(await chromeViolations(page)).toEqual([]);
    const box = page.getByRole('combobox', { name: 'Add class' });
    await box.fill('w');
    await expect(page.getByRole('listbox', { name: 'Classes suggestions' })).toBeVisible();
    expect(await chromeViolations(page)).toEqual([]);
    await box.press('Escape');
    await page.getByRole('textbox', { name: 'Style' }).fill('bad');
    await page.getByRole('textbox', { name: 'Style' }).press('Tab');
    expect(await chromeViolations(page)).toEqual([]);
    await page.getByRole('tab', { name: 'Page' }).click();
    await page.getByTestId('inspector-objects').getByRole('button').first().click().catch(() => {});
    expect(await chromeViolations(page)).toEqual([]);

    await page.getByTestId('scheme-select').selectOption('dark');
    await transitionsDone(page);
    expect(await chromeViolations(page)).toEqual([]);
    await page.getByRole('tab', { name: 'Element' }).click();
    expect(await chromeViolations(page)).toEqual([]);
  });
});
