// The import report before saving (plan §7 "Import report", P6.3), with the API stubbed (runs
// anywhere): every count of §7 is on the page, with the pages that clipped upstream and how many
// pages they grew into once the read-only preview has paginated them; nothing is saved yet.
import { expect, test } from '@playwright/test';
import { chromeViolations, LOAD_TIMEOUT, openImport, pasteAndPreview, report, REPORT_BREW, reportCount, settledPageCount, stubApi, waitForReport } from './helpers';

test('the report shows every count before the brew is saved', async ({ page }) => {
  const brewRequests = await stubApi(page);
  await openImport(page);
  await pasteAndPreview(page, REPORT_BREW);
  await waitForReport(page);

  // Pages: 2 in the source, more once laid out (page 2 clipped upstream and grew). The report's
  // count is the preview's.
  const pages = await settledPageCount(page);
  expect(pages).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId('import-report-pages')).toContainText('2 pages in the source');
  await expect(reportCount(page, 'clipped')).toHaveText('1');
  const clipped = page.getByTestId('import-report-clipped');
  await clipped.getByText('Show it').click();
  await expect(clipped.getByRole('list', { name: 'Pages that were cut off' })).toContainText(`Page 2: now ${pages - 1} pages`);

  // Variables (value written into the text), raw HTML, comments, unknown classes, lost attributes.
  await expect(reportCount(page, 'variables')).toHaveText('1');
  await expect(page.getByTestId('import-report-variables')).toContainText('values were written into the text');
  await expect(reportCount(page, 'raw-html')).toHaveText('1');
  await expect(reportCount(page, 'comments')).toHaveText('1');
  const unknown = page.getByTestId('import-report-unknown-classes');
  await expect(reportCount(page, 'unknown-classes')).toHaveText('1');
  await unknown.getByText('Show it').click();
  await expect(unknown.getByRole('list', { name: 'Unknown classes' })).toContainText('.zzUnknownImportClass ×1');
  await expect(reportCount(page, 'transparent')).toHaveText('1');

  // The preview: read-only, the brew's theme and CSS, the variable's value inlined.
  const preview = page.getByTestId('import-preview');
  await expect(preview.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
  await expect(preview.getByText('Welcome to the Drowned Hall.')).toBeVisible();
  await expect(page.getByTestId('import-meta-title')).toHaveText('The Sunken Vault');
  await expect(page.getByTestId('import-meta-theme')).toHaveText(/5e DMG/i);
  await expect(page.getByTestId('import-meta-tags')).toHaveText('dungeon, e2e');
  await expect(page.getByTestId('import-meta-snippets')).toHaveText('1');

  // Nothing was saved.
  await expect(page.getByTestId('import-create-button')).toHaveText('Create brew');
  expect(brewRequests).toEqual([]);
  expect(await chromeViolations(page)).toEqual([]);
});

test('a legacy-renderer brew is refused with an explanation', async ({ page }) => {
  await stubApi(page);
  await openImport(page);
  await pasteAndPreview(page, '```metadata\nrenderer: legacy\n```\n\n# Old brew\n');
  const problem = page.getByTestId('import-convert-error');
  await expect(problem).toBeVisible(LOAD_TIMEOUT);
  await expect(problem).toContainText('This brew uses the legacy renderer');
  await expect(problem).toContainText('switch the renderer to V3');
  await expect(page.getByTestId('import-create')).toHaveCount(0);
  expect(await chromeViolations(page)).toEqual([]);
});

test('the report is keyboard operable and the preview scrolls from the keyboard', async ({ page }) => {
  await stubApi(page);
  await openImport(page);
  await pasteAndPreview(page, REPORT_BREW);
  await waitForReport(page);
  // The result's heading has the focus after the conversion.
  await expect(page.getByRole('heading', { level: 2, name: '2. Check the import' })).toBeFocused();
  const toggle = page.getByTestId('import-report-raw-html').getByText('Show it');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('import-report-raw-html').getByRole('list', { name: 'Raw HTML samples' })).toContainText('<section');
  const region = page.getByRole('region', { name: 'Preview of the imported brew' });
  await region.focus();
  await expect(region).toBeFocused();
  await expect(report(page)).toBeVisible();
});
