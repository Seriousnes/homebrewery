// What /import says when a source can't be used (plan §7, P6.1), with the API stubbed (runs
// anywhere): the upstream proxy's answers (400, 404, 413, 429, 502 with and without
// upstreamStatus), links and ids that are refused before any request (edit links, 7-9 character
// legacy ids, Google Drive ids, other sites), files that aren't brew text, and signed-out
// downloads. Every state is axe clean.
import { expect, test } from '@playwright/test';
import {
  chromeViolations,
  LOAD_TIMEOUT,
  openImport,
  SHARE_ID,
  simpleBrew,
  stubApi,
  stubUpstream,
  upstreamProblem,
  upstreamText,
  waitForReport,
} from './helpers';

test('the proxy’s errors each get a clear message', async ({ page }) => {
  await stubApi(page);
  let answer = upstreamProblem(404);
  const asked = await stubUpstream(page, (id, route) => answer(id, route));
  await openImport(page);
  await page.getByRole('tab', { name: 'Homebrewery link' }).click();
  const field = page.getByLabel('Share link or share id');
  const download = page.getByRole('button', { name: 'Download and preview' });
  const problem = page.getByTestId('import-link-error');

  const cases: Array<[ReturnType<typeof upstreamProblem>, RegExp]> = [
    [upstreamProblem(400, { errors: { shareId: ['Invalid'] } }), /isn’t a Homebrewery share id/],
    [upstreamProblem(404), /has no brew with this share id/],
    [upstreamProblem(413), /larger than 2 MB/],
    [upstreamProblem(429, {}, { 'Retry-After': '30' }), /Try again in 30 seconds/],
    [upstreamProblem(502, { upstreamStatus: 455 }), /code 455, which means the brew is locked/],
    [upstreamProblem(502, { upstreamStatus: 503 }), /error 503: it may be having problems/],
    [upstreamProblem(502, { upstreamStatus: 403 }), /refused the download \(error 403\)/],
    [upstreamProblem(502), /didn’t send the brew’s text/],
  ];
  for (const [respond, message] of cases) {
    answer = respond;
    await field.fill(SHARE_ID);
    await download.click();
    await expect(problem).toContainText('Couldn’t download the brew');
    await expect(problem).toContainText(message);
    // Typing clears the message.
    await field.press('End');
    await field.pressSequentially(' ');
    await expect(problem).toHaveCount(0);
  }
  expect(asked).toHaveLength(cases.length);
  await expect(page.getByTestId('import-check')).toHaveCount(0);

  answer = upstreamProblem(502, { upstreamStatus: 455 });
  await field.fill(SHARE_ID);
  await download.click();
  await expect(problem).toBeVisible();
  expect(await chromeViolations(page)).toEqual([]);
});

test('links and ids that can’t be downloaded are explained without a request', async ({ page }) => {
  await stubApi(page);
  const asked = await stubUpstream(page, upstreamText(simpleBrew('Never')));
  await openImport(page);
  await page.getByRole('tab', { name: 'Homebrewery link' }).click();
  const field = page.getByLabel('Share link or share id');
  const problem = page.getByTestId('import-link-error');
  const cases: Array<[string, RegExp]> = [
    ['', /Paste the brew’s share link or its share id/],
    ['https://homebrewery.naturalcrit.com/edit/abcdefghijkl', /That is an edit link/],
    ['abc1234', /7 to 9 characters belong to old Homebrewery brews/],
    [`https://homebrewery.naturalcrit.com/share/1${'a'.repeat(40)}bcdefghijk`, /author’s Google Drive/],
    ['https://example.com/share/abcdefghijkl', /isn’t on the Homebrewery/],
    ['https://homebrewery.naturalcrit.com/vault', /doesn’t point to a brew/],
    ['not a link at all', /doesn’t look like a Homebrewery share link/],
  ];
  for (const [input, message] of cases) {
    await field.fill(input);
    await field.press('Enter');
    await expect(problem).toContainText(message);
  }
  expect(asked).toEqual([]);
  expect(await chromeViolations(page)).toEqual([]);
});

test('a bare share id and a /share/ link both download', async ({ page }) => {
  await stubApi(page);
  const asked = await stubUpstream(page, upstreamText(simpleBrew('From Upstream')));
  await openImport(page);
  await page.getByRole('tab', { name: 'Homebrewery link' }).click();
  const field = page.getByLabel('Share link or share id');
  await field.fill(`  ${SHARE_ID}  `);
  await field.press('Enter');
  await waitForReport(page);
  await expect(page.getByTestId('import-preview').getByRole('heading', { name: 'From Upstream' })).toBeVisible();
  await page.getByTestId('import-start-over').click();
  await expect(page.getByTestId('import-check')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Homebrewery link' }).click();
  await field.fill(`homebrewery.naturalcrit.com/share/${SHARE_ID}?x=1`);
  await field.press('Enter');
  await waitForReport(page);
  expect(asked).toEqual([SHARE_ID, SHARE_ID]);
});

test('signed out, "Sign in and download" asks to sign in first', async ({ page }) => {
  await stubApi(page, { signedIn: false });
  const asked = await stubUpstream(page, upstreamText(simpleBrew('Never')));
  await openImport(page);
  await page.getByRole('tab', { name: 'Homebrewery link' }).click();
  await expect(page.getByTestId('import-link-sign-in-note')).toBeVisible();
  await page.getByLabel('Share link or share id').fill(SHARE_ID);
  await page.getByRole('button', { name: 'Sign in and download' }).click();
  await expect(page.getByTestId('sign-in-prompt')).toBeVisible();
  expect(asked).toEqual([]);
  expect(await chromeViolations(page)).toEqual([]);
});

test('files that aren’t brew text are refused with a reason', async ({ page }) => {
  await stubApi(page);
  await openImport(page);
  await page.getByRole('tab', { name: 'Upload a file' }).click();
  const input = page.getByLabel('Brew file');
  const problem = page.getByTestId('import-file-error');
  const cases: Array<[{ name: string; mimeType: string; buffer: Buffer }, RegExp]> = [
    [{ name: 'map.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, /Choose a \.txt or \.md file/],
    [{ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }, /This file is empty/],
    [{ name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([0x41, 0x00, 0x42, 0x00, 0x43]) }, /doesn’t contain text/],
    [{ name: 'huge.md', mimeType: 'text/markdown', buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61) }, /Brews of up to 2 MB can be imported/],
  ];
  for (const [file, message] of cases) {
    await input.setInputFiles(file);
    await expect(problem).toContainText(message);
  }
  await expect(page.getByTestId('import-check')).toHaveCount(0);
  expect(await chromeViolations(page)).toEqual([]);

  // A good file after a refusal: the message goes, the preview starts.
  await input.setInputFiles({ name: 'good.md', mimeType: 'text/markdown', buffer: Buffer.from(simpleBrew('Good File'), 'utf8') });
  await expect(problem).toHaveCount(0);
  await waitForReport(page);
  await expect(page.getByTestId('import-source')).toContainText('From the file good.md');
});

test('an empty paste and an oversized paste are refused', async ({ page }) => {
  await stubApi(page);
  await openImport(page);
  const field = page.getByLabel('Brew text');
  await page.getByRole('button', { name: 'Preview the import' }).click();
  await expect(page.getByTestId('import-paste-error')).toContainText('Paste the brew’s text first.');
  await expect(field).toBeFocused();
  // Over 2 MB in UTF-8 (the limit counts bytes): 700,000 × '€' (3 bytes each) is 2.1 MB. Set in the
  // page with the native setter plus an input event (what React listens to): fill() of a text this
  // long takes minutes in Firefox.
  await field.evaluate((el: HTMLTextAreaElement, text) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the prototype's setter, called on the element
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setValue?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, '€'.repeat(700_000));
  await page.getByRole('button', { name: 'Preview the import' }).click();
  await expect(page.getByTestId('import-paste-error')).toContainText('Brews of up to 2 MB can be imported');
  await expect(page.getByTestId('import-check')).toHaveCount(0);
});

test('narrow screens: the import page fits a phone’s width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await openImport(page);
  await page.getByLabel('Brew text').fill(simpleBrew('Small Screen'));
  await page.getByRole('button', { name: 'Preview the import' }).click();
  await waitForReport(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Create brew' })).toBeInViewport(LOAD_TIMEOUT);
  expect(await chromeViolations(page)).toEqual([]);
});
