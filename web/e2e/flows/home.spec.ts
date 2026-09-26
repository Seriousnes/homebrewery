// The home page (plan §9, P7.2): the bundled welcome brew in the full editor, editable locally and
// never saved, plus the editor's panels and menus working together. The API is stubbed (no
// account, static themes), so this runs anywhere.
import { expect, type Page, test } from '@playwright/test';
import { chromeViolations, editorRoot, editorTexts, LOAD_TIMEOUT, nav, printCount, stubPrint, typeAt, waitForEditor } from './helpers';

/** Anonymous, no notices, static themes; records every brew request (there must be none). */
async function stubApi(page: Page): Promise<string[]> {
  const brewRequests: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/brews')) brewRequests.push(`${route.request().method()} ${url.pathname}`);
      if (url.pathname === '/api/account/me') return route.fulfill({ status: 204 });
      if (url.pathname === '/api/notifications/active') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
    },
  );
  return brewRequests;
}

async function openHome(page: Page): Promise<string[]> {
  const brewRequests = await stubApi(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  return brewRequests;
}

test('the welcome brew is editable and never saved', { tag: '@smoke' }, async ({ page }) => {
  const brewRequests = await openHome(page);
  await expect(page.getByRole('heading', { level: 1, name: 'The Homebrewery', exact: true })).toBeAttached();
  await expect(page).toHaveTitle('The Homebrewery');
  // The welcome brew, laid out by the theme and paginated.
  await expect(editorRoot(page).getByRole('heading', { level: 1, name: /The Homebrewery V3/ })).toBeVisible();
  expect(await page.locator('.hb-canvas .page').count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('home-not-saved')).toHaveText('Changes here are not saved');
  await expect(page.getByTestId('save-status')).toHaveCount(0);
  await expect(page.getByTestId('open-properties')).toHaveCount(0);

  // Edits work (and undo), but nothing is saved: no request, no draft, a note on Mod-S.
  await typeAt(page, ' Edited here.', 1);
  expect((await editorTexts(page))?.[1]).toContain('Edited here.');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('This page is never saved', { exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await editorTexts(page))?.[1]).not.toContain('Edited here.');
  await page.waitForTimeout(3500); // past the autosave delay
  expect(brewRequests).toEqual([]);
  const drafts = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('hb-drafts');
        // Never create the database here (the app's store creates it with its object store).
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => resolve(0);
        open.onsuccess = () => {
          const db = open.result;
          const done = (n: number) => {
            db.close();
            resolve(n);
          };
          if (!db.objectStoreNames.contains('drafts')) return done(0);
          const count = db.transaction('drafts', 'readonly').objectStore('drafts').count();
          count.onsuccess = () => done(count.result);
          count.onerror = () => done(0);
        };
      }),
  );
  expect(drafts).toBe(0);

  // "Create your own" starts a new brew.
  await page.getByTestId('home-create').click();
  await expect(page).toHaveURL(/\/new$/, LOAD_TIMEOUT);
  await waitForEditor(page);
  await expect(page.getByRole('heading', { level: 1, name: 'New brew' })).toBeAttached();
});

test('app chrome passes axe; print shows only the pages', async ({ page }) => {
  await openHome(page);
  expect(await chromeViolations(page)).toEqual([]);
  await stubPrint(page);
  await page.getByTestId('print').click();
  await expect.poll(() => printCount(page)).toBe(1);
  // Ctrl+P anywhere on the page (here: with the focus on the navbar).
  await nav(page).getByTestId('nav-new').focus();
  await page.keyboard.press('ControlOrMeta+p');
  await expect.poll(() => printCount(page)).toBe(2);
});

test('panels: outline navigation, the style drawer restyles the pages, the insert menu adds a snippet as one undo step', async ({ page }) => {
  await openHome(page);

  // Outline: a toggle with aria-expanded/aria-controls, headings of the welcome brew.
  const outlineToggle = page.getByTestId('toggle-outline');
  if ((await outlineToggle.getAttribute('aria-expanded')) === 'true') await outlineToggle.click();
  await outlineToggle.click();
  await expect(outlineToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(outlineToggle).toHaveAttribute('aria-controls', 'hb-outline-panel');
  const outline = page.getByTestId('outline-panel');
  await expect(outline).toBeVisible();
  await expect(outline.getByRole('link', { name: /The Homebrewery V3/ })).toBeVisible();

  // Style drawer: brew CSS restyles the canvas.
  const styleToggle = page.getByTestId('toggle-style');
  if ((await styleToggle.getAttribute('aria-expanded')) !== 'true') await styleToggle.click();
  const styles = page.getByTestId('style-panel');
  await expect(styles).toBeVisible();
  await styles.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n.page { border-top: 7px solid rgb(1, 2, 3); }\n');
  await expect
    .poll(() => page.locator('.hb-canvas .page').first().evaluate((el) => getComputedStyle(el).borderTopWidth), LOAD_TIMEOUT)
    .toBe('7px');
  await styleToggle.click();
  await expect(styles).toHaveCount(0);

  // Insert menu: a snippet of the theme (a note block), one undo step.
  const before = await page.locator('.hb-canvas .page .note').count();
  await typeAt(page, '', 0);
  await page.getByTestId('insert-menu').click();
  const search = page.getByRole('combobox', { name: 'Search snippets' });
  await search.fill('Note');
  await search.press('Enter');
  await expect(page.getByTestId('insert-menu-status')).toContainText('inserted');
  await expect.poll(() => page.locator('.hb-canvas .page .note').count(), LOAD_TIMEOUT).toBe(before + 1);
  await editorRoot(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => page.locator('.hb-canvas .page .note').count()).toBe(before);
});
