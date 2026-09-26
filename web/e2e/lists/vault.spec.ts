// /vault against a real API (plan §9, P7.3): websearch syntax, the author filter, sort and
// direction, pagination, and the URL as the state (reload, Back); empty and error states; keyboard,
// axe and a phone width. Every test searches for its own unique word, so brews left by earlier runs
// never change the results. Run with node e2e/lists/run-lists.mjs.
import type { Page } from '@playwright/test';
import {
  addViews,
  axeViolations,
  createBrew,
  DOM_READY,
  expect,
  horizontalOverflow,
  LOAD_TIMEOUT,
  NEEDS_API,
  offscreen,
  privateApi,
  test,
  transitionsDone,
  uid,
  vaultTitles,
} from './helpers';

test.skip(!privateApi, NEEDS_API);

const status = (page: Page) => page.getByTestId('vault-status');
const searchBox = (page: Page) => page.getByRole('searchbox', { name: /^Search/ });

test('searches with websearch syntax and an author filter; sorts; the URL keeps it all', async ({ account, page, baseURL }) => {
  const [alice, bob] = await Promise.all([account(), account()]);
  const word = `vt${uid()}`;
  const [, beta, , , delta] = await Promise.all([
    createBrew(alice.request, baseURL!, { title: `${word} Alpha dragon`, description: 'Scales and fire' }),
    createBrew(alice.request, baseURL!, { title: `${word} Beta dragon` }),
    createBrew(alice.request, baseURL!, { title: `${word} Gamma kobold` }),
    createBrew(alice.request, baseURL!, { title: `${word} Hidden dragon`, published: false }),
    createBrew(bob.request, baseURL!, { title: `${word} Delta dragon` }),
  ]);
  await addViews(baseURL!, beta.shareId, 3);
  await addViews(baseURL!, delta.shareId, 1);

  await page.goto('/vault', DOM_READY);
  await expect(page.getByRole('heading', { level: 1, name: 'Vault' })).toBeVisible(LOAD_TIMEOUT);
  await expect(page.getByRole('search', { name: 'Vault search' })).toBeVisible();

  // Two words: both must match; unpublished brews never show.
  await searchBox(page).fill(`${word} dragon`);
  await searchBox(page).press('Enter');
  await expect(page).toHaveURL(`/vault?q=${word}+dragon`);
  await expect(status(page)).toHaveText('3 brews found.');
  expect((await vaultTitles(page)).sort()).toEqual([`${word} Alpha dragon`, `${word} Beta dragon`, `${word} Delta dragon`]);
  await expect(page.getByRole('group', { name: 'Sort by' }).getByRole('button', { name: /^Relevance/ })).toHaveAttribute('aria-pressed', 'true');
  // Vault items never carry the owner's actions; Clone needs a signed-in reader.
  await expect(page.getByTestId('brew-edit')).toHaveCount(0);
  await expect(page.getByTestId('brew-clone')).toHaveCount(0);

  // A minus leaves a word out; quotes find a phrase.
  await searchBox(page).fill(`${word} -dragon`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect.poll(() => vaultTitles(page)).toEqual([`${word} Gamma kobold`]);
  await expect(status(page)).toHaveText('1 brew found.');
  await searchBox(page).fill(`"${word} beta"`);
  await searchBox(page).press('Enter');
  await expect.poll(() => vaultTitles(page)).toEqual([`${word} Beta dragon`]);
  await expect(status(page)).toHaveText('1 brew found.');

  // The author filter (a handle, any case).
  await searchBox(page).fill(word);
  await page.getByRole('textbox', { name: /^Author/ }).fill(alice.handle.toUpperCase());
  await searchBox(page).press('Enter');
  await expect.poll(async () => (await vaultTitles(page)).sort()).toEqual([`${word} Alpha dragon`, `${word} Beta dragon`, `${word} Gamma kobold`]);
  await expect(status(page)).toHaveText('3 brews found.');
  await page.getByRole('textbox', { name: /^Author/ }).fill('');
  await searchBox(page).press('Enter');
  await expect(status(page)).toHaveText('4 brews found.');

  // Sort and direction.
  const sortBar = page.getByRole('group', { name: 'Sort by' });
  await sortBar.getByRole('button', { name: /^Title/ }).click();
  await expect(page).toHaveURL(/sort=title&dir=asc/);
  await expect.poll(() => vaultTitles(page)).toEqual([`${word} Alpha dragon`, `${word} Beta dragon`, `${word} Delta dragon`, `${word} Gamma kobold`]);
  await sortBar.getByRole('button', { name: /^Title/ }).click();
  await expect(page).toHaveURL(/sort=title&dir=desc/);
  await expect.poll(() => vaultTitles(page)).toEqual([`${word} Gamma kobold`, `${word} Delta dragon`, `${word} Beta dragon`, `${word} Alpha dragon`]);
  await sortBar.getByRole('button', { name: /^Views/ }).click();
  await expect.poll(async () => (await vaultTitles(page)).slice(0, 2)).toEqual([`${word} Beta dragon`, `${word} Delta dragon`]);

  // Reload and Back: the URL is the state.
  await page.reload(DOM_READY);
  await expect(status(page)).toHaveText('4 brews found.', LOAD_TIMEOUT);
  await expect(searchBox(page)).toHaveValue(word);
  await expect(page.getByRole('group', { name: 'Sort by' }).getByRole('button', { name: /^Views/ })).toHaveAttribute('aria-pressed', 'true');
  await page.goBack(DOM_READY);
  await expect(page).toHaveURL(/sort=title&dir=desc/);
  await expect.poll(() => vaultTitles(page)).toEqual([`${word} Gamma kobold`, `${word} Delta dragon`, `${word} Beta dragon`, `${word} Alpha dragon`]);

  expect(await axeViolations(page)).toEqual([]);
});

test('pages through results with links, from the keyboard too; the page size is a choice', async ({ account, page, baseURL }) => {
  const alice = await account();
  const word = `vp${uid()}`;
  await Promise.all(Array.from({ length: 12 }, (_, i) => createBrew(alice.request, baseURL!, { title: `${word} n${String(i + 1).padStart(2, '0')}` })));

  await page.goto(`/vault?q=${word}&sort=title&pageSize=10`, DOM_READY);
  await expect(status(page)).toHaveText('12 brews found. Page 1 of 2.', LOAD_TIMEOUT);
  expect(await vaultTitles(page)).toHaveLength(10);
  const pages = page.getByRole('navigation', { name: 'Result pages' });
  await expect(pages.locator('[aria-current="page"]')).toHaveText('Page 1');

  await pages.getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(`/vault?q=${word}&sort=title&page=2&pageSize=10`);
  await expect(status(page)).toHaveText('12 brews found. Page 2 of 2.');
  await expect.poll(() => vaultTitles(page)).toEqual([`${word} n11`, `${word} n12`]);
  await expect(page.getByRole('heading', { level: 2, name: 'Results' })).toBeFocused();

  // Keyboard: a page link follows Enter; Back returns to the page before.
  await pages.getByRole('link', { name: 'Page 1' }).focus();
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveText('12 brews found. Page 1 of 2.');
  await page.goBack(DOM_READY);
  await expect(status(page)).toHaveText('12 brews found. Page 2 of 2.');

  // A bigger page: one page, no page links.
  await page.getByRole('combobox', { name: 'Results per page' }).selectOption('20');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(`/vault?q=${word}&sort=title`);
  await expect(status(page)).toHaveText('12 brews found.');
  expect(await vaultTitles(page)).toHaveLength(12);
  await expect(page.getByRole('navigation', { name: 'Result pages' })).toHaveCount(0);
});

test('empty and error states, with axe in light and dark', async ({ page }) => {
  await page.goto(`/vault?q=nothing${uid()}`, DOM_READY);
  await expect(status(page)).toHaveText('No brews found.', LOAD_TIMEOUT);
  await expect(page.getByTestId('vault-empty')).toContainText('No published brew matches.');
  expect(await axeViolations(page)).toEqual([]);

  // Longer than the API allows (only a URL can do that: the field stops at 256 characters).
  await page.goto(`/vault?q=${'x'.repeat(300)}`, DOM_READY);
  await expect(page.getByTestId('vault-error')).toContainText('Fix the search above and try again.', LOAD_TIMEOUT);
  await expect(searchBox(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('The search must be at most 256 characters.')).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  // The switch fades colours: axe's contrast check must see the final ones.
  await transitionsDone(page);
  expect(await axeViolations(page)).toEqual([]);
  await searchBox(page).fill('ok');
  await searchBox(page).press('Enter');
  await expect(page.getByTestId('vault-error')).toHaveCount(0);
  await expect(searchBox(page)).not.toHaveAttribute('aria-invalid', 'true');
});

test('a failed search shows the problem in place with Try again', async ({ page }) => {
  let failing = true;
  await page.route(
    (url) => url.pathname === '/api/vault',
    (route) =>
      failing
        ? route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Internal Server Error', status: 500 }) })
        : route.fallback(),
  );
  await page.goto(`/vault?q=nothing${uid()}`, DOM_READY);
  const problem = page.getByTestId('vault-error');
  // A 500 is retried twice first (the app's query policy).
  await expect(problem).toBeVisible(LOAD_TIMEOUT);
  await expect(problem).toHaveAttribute('role', 'alert');
  await expect(status(page)).toHaveText("Couldn't search the vault.");
  await expect(page.getByTestId('vault-pagination')).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
  failing = false;
  await problem.getByRole('button', { name: 'Try again' }).click();
  await expect(problem).toHaveCount(0);
  await expect(status(page)).toHaveText('No brews found.');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 320, height: 720 } });

  test('fits a phone (320 px): the form stacks above the results', async ({ account, page, baseURL }) => {
    const alice = await account();
    const word = `vn${uid()}`;
    await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        createBrew(alice.request, baseURL!, { title: `${word} a rather long title number ${i + 1}`, tags: ['type:Adventure', 'unbreakable-tag-with-no-spaces-at-all'] }),
      ),
    );
    await page.goto(`/vault?q=${word}&pageSize=10`, DOM_READY);
    await expect(status(page)).toHaveText('11 brews found. Page 1 of 2.', LOAD_TIMEOUT);
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0 });
    expect(await offscreen(page, '[data-testid^="brew-"], [data-testid^="vault-"], button, a')).toEqual([]);
    const form = await page.getByTestId('vault-form').boundingBox();
    const results = await page.getByTestId('vault-results').boundingBox();
    expect(form!.y + form!.height).toBeLessThanOrEqual(results!.y);
    expect(await axeViolations(page)).toEqual([]);
  });
});
