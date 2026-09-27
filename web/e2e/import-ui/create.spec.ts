// /import creates brews (plan §7, §9, P6.1 "All three sources create a brew") against a real
// API: pasted text, an uploaded file and a Homebrewery share link (the API's upstream proxy is
// answered by page.route: no network). Each shows the report before anything is saved, then
// "Create brew" POSTs the document, CSS, snippets, metadata and source text and opens /edit.
// Anonymous visitors are asked to sign in, and the page keeps their text across the sign-in.
// Needs a private API (run with e2e/import-ui/run-import-ui.mjs, or the flows/suite runners).
import { expect, type Page, test } from '@playwright/test';
import { editorTexts, PASSWORD, privateApi, registerOnly, signUpApi, uniqueEmail, waitForEditor } from '../flows/helpers';
import {
  LOAD_TIMEOUT,
  openImport,
  pasteAndPreview,
  reportBrew,
  reportCount,
  settledPageCount,
  SHARE_ID,
  simpleBrew,
  stubUpstream,
  upstreamText,
  waitForReport,
} from './helpers';

test.skip(!privateApi, 'needs a private API (HB_API_URL); run e2e/import-ui/run-import-ui.mjs');

interface StoredBrew {
  editId: string;
  doc: unknown;
  style: string;
  snippets: unknown;
  sourceMarkdown: string | null;
  pageCount: number;
  meta: { title: string; description: string; tags: string[]; lang: string; theme: string };
}

/** Records every POST /api/brews the page makes. */
function recordCreates(page: Page): string[] {
  const creates: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/brews') creates.push(request.url());
  });
  return creates;
}

/** Clicks "Create brew" and waits for the brew's editor; returns the stored brew. */
async function createAndOpen(page: Page): Promise<StoredBrew> {
  await page.getByRole('button', { name: 'Create brew' }).click();
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, LOAD_TIMEOUT);
  await waitForEditor(page);
  return storedBrew(page);
}

async function storedBrew(page: Page): Promise<StoredBrew> {
  const editId = new URL(page.url()).pathname.split('/').pop()!;
  const res = await page.request.get(`/api/brews/edit/${editId}`);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as StoredBrew;
}

const importSession = (page: Page) => page.evaluate(() => sessionStorage.getItem('hb-import-session'));

test('pasted text: the report first, then the brew with its metadata, CSS, snippets and source', { tag: '@smoke' }, async ({ page, baseURL }) => {
  // One clipped page that grows into two (report.spec's grows into three).
  const text = reportBrew(60);
  await signUpApi(page.request, baseURL!, uniqueEmail('import-paste'));
  const creates = recordCreates(page);
  await openImport(page);
  await pasteAndPreview(page, text);
  await waitForReport(page);
  const pages = await settledPageCount(page);
  expect(pages).toBeGreaterThanOrEqual(3);
  await expect(reportCount(page, 'clipped')).toHaveText('1');
  await expect(reportCount(page, 'variables')).toHaveText('1');
  await expect(reportCount(page, 'raw-html')).toHaveText('1');
  await expect(reportCount(page, 'comments')).toHaveText('1');
  await expect(reportCount(page, 'unknown-classes')).toHaveText('1');
  expect(creates).toEqual([]);

  const brew = await createAndOpen(page);
  expect(creates).toHaveLength(1);
  expect(brew.meta).toMatchObject({ title: 'The Sunken Vault', description: 'A short flooded dungeon.', tags: ['dungeon', 'e2e'], lang: 'en', theme: '5eDMG' });
  expect(brew.style).toContain('.vaultGlow');
  expect(brew.snippets).toEqual([{ name: 'Trap note', gen: '{{note\n##### Pit trap\nThe floor gives way.\n}}' }]);
  expect(brew.sourceMarkdown).toBe(text);
  // Saved already laid out: the page count the report showed.
  expect(brew.pageCount).toBe(pages);
  expect(JSON.stringify(brew.doc)).toContain('Welcome to the Drowned Hall.');
  expect(await editorTexts(page)).toContain('Welcome to the Drowned Hall.');
  await expect(page.locator('.hb-canvas .page')).toHaveCount(brew.pageCount);
  // The import is done: nothing kept for this tab any more.
  expect(await importSession(page)).toBeNull();
});

test('an uploaded file (Windows-1252 text) creates a brew', async ({ page, baseURL }) => {
  await signUpApi(page.request, baseURL!, uniqueEmail('import-file'));
  await openImport(page);
  await page.getByRole('tab', { name: 'Upload a file' }).click();
  // "Café" and "brûlée" in Windows-1252 bytes (not UTF-8).
  const text = '# Café of the Deep\n\nCrème brûlée for the whole party.\n';
  await page.getByLabel('Brew file').setInputFiles({ name: 'deep-cafe.txt', mimeType: 'text/plain', buffer: Buffer.from(text, 'latin1') });
  await waitForReport(page);
  await expect(page.getByTestId('import-source')).toContainText('From the file deep-cafe.txt');
  const notes = page.getByTestId('import-report-warnings');
  await notes.getByText(/^Show/).click();
  await expect(notes).toContainText('read as Windows-1252');
  await expect(page.getByTestId('import-preview').getByText('Crème brûlée for the whole party.')).toBeVisible();

  const brew = await createAndOpen(page);
  expect(brew.sourceMarkdown).toBe(text);
  expect(brew.meta.theme).toBe('5ePHB');
  expect(await editorTexts(page)).toEqual(['Café of the Deep', 'Crème brûlée for the whole party.']);
});

test('a Homebrewery share link downloads through the proxy and creates a brew', async ({ page, baseURL }) => {
  await signUpApi(page.request, baseURL!, uniqueEmail('import-link'));
  const upstream = '```metadata\ntitle: Linked Lair\ntags: [linked]\ntheme: 5ePHB\n```\n\n' + simpleBrew('Linked Lair', 'Downloaded from upstream.');
  const asked = await stubUpstream(page, upstreamText(upstream));
  await openImport(page);
  await page.getByRole('tab', { name: 'Homebrewery link' }).click();
  await page.getByLabel('Share link or share id').fill(`https://homebrewery.naturalcrit.com/share/${SHARE_ID}`);
  await page.getByRole('button', { name: 'Download and preview' }).click();
  await waitForReport(page);
  expect(asked).toEqual([SHARE_ID]);
  await expect(page.getByTestId('import-source')).toContainText(`the Homebrewery brew ${SHARE_ID}`);
  await expect(page.getByTestId('import-source').getByRole('link', { name: /open it on the Homebrewery/ })).toHaveAttribute(
    'href',
    `https://homebrewery.naturalcrit.com/share/${SHARE_ID}`,
  );

  const brew = await createAndOpen(page);
  expect(brew.sourceMarkdown).toBe(upstream);
  expect(brew.meta).toMatchObject({ title: 'Linked Lair', tags: ['linked'], theme: '5ePHB' });
  expect(await editorTexts(page)).toEqual(['Linked Lair', 'Downloaded from upstream.']);
});

test('anonymous: "Create" keeps the brew on this device (issue #4), with nothing sent', async ({ page }) => {
  const creates = recordCreates(page);
  await openImport(page);
  await pasteAndPreview(page, simpleBrew('Kept Locally'));
  await waitForReport(page);
  await expect(page.getByTestId('import-sign-in-note')).toContainText('the brew is kept in this browser');
  await page.getByRole('button', { name: 'Create brew on this device' }).click();
  await expect(page).toHaveURL(/\/local\/[\w-]+$/, LOAD_TIMEOUT);
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Kept Locally', 'Imported words.']);
  await expect(page.getByTestId('save-status-label')).toHaveText('Saved on this device');
  expect(creates).toHaveLength(0);
});

test('anonymous: the pasted text and its preview survive a trip to the sign-in page', async ({ page, baseURL, request }) => {
  const email = await registerOnly(request, baseURL!, uniqueEmail('import-trip'));
  await openImport(page);
  const text = simpleBrew('Kept Across Sign-in', 'Still here after signing in.');
  await pasteAndPreview(page, text);
  await waitForReport(page);

  // The navbar's sign-in page, and back (returnTo).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fimport$/, LOAD_TIMEOUT);
  const form = page.getByTestId('login-form');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/import$/, LOAD_TIMEOUT);

  // The text is back in its field, and converted again.
  await expect(page.getByLabel('Brew text')).toHaveValue(text);
  await waitForReport(page);
  await expect(page.getByTestId('import-sign-in-note')).toHaveCount(0);
  const brew = await createAndOpen(page);
  expect(brew.sourceMarkdown).toBe(text);
  expect(await editorTexts(page)).toEqual(['Kept Across Sign-in', 'Still here after signing in.']);
});
