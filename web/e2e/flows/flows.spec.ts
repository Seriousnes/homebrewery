// The plan §12 end-to-end flow against a real API: sign up → new brew → type → autosave →
// reload → share (read-only) → print preview. Needs a private API behind the Vite proxy:
//
//   node e2e/flows/run-flows.mjs          (from web/: starts the API on :5429 and Vite on :5329)
//
// or HB_API_URL=http://localhost:5429 E2E_PORT=5329 npx playwright test e2e/flows with an API
// you started yourself (see run-flows.mjs for its settings). Skipped without HB_API_URL.
import { expect, test } from '@playwright/test';
import {
  appRoot,
  chromeViolations,
  editorRoot,
  editorTexts,
  LOAD_TIMEOUT,
  nav,
  PASSWORD,
  pdfPageCount,
  printLayout,
  privateApi,
  SAVE_TIMEOUT,
  saveStatus,
  storedBrew,
  typeAt,
  uniqueEmail,
  waitForEditor,
} from './helpers';

test.skip(!privateApi, 'Needs a private API: HB_API_URL=http://localhost:5429 (see e2e/flows/run-flows.mjs)');

test('sign up → new brew → type → autosave → reload → share read-only → print preview', { tag: '@smoke' }, async ({ page, browserName }) => {
  // The plan's whole flow in one test: two page loads and two more editor routes, two autosaves,
  // two axe scans and (Chromium) a PDF.
  test.setTimeout(40_000);
  // Sign up (the register page signs in and opens the account page).
  const email = uniqueEmail('flows-main');
  await page.goto('/register', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account$/, LOAD_TIMEOUT);

  // New brew from the navbar.
  await nav(page).getByRole('button', { name: 'New' }).click();
  const newBrew = page.getByTestId('nav-new-panel').getByRole('link', { name: /^New brew/ });
  await expect(newBrew).toBeVisible();
  await newBrew.click();
  // The editor's route module loads before the URL changes.
  await expect(page).toHaveURL(/\/new$/, LOAD_TIMEOUT);
  await waitForEditor(page);
  await expect(page.getByRole('heading', { level: 1, name: 'New brew' })).toBeAttached();
  await expect(saveStatus(page)).toHaveText('Not saved yet');
  // The editor has the caret: typing goes straight into the brew.
  await expect(editorRoot(page)).toBeFocused();

  // Type; the first autosave creates the brew and the page moves to /edit/:editId.
  await typeAt(page, 'Hello from the end-to-end flow');
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, SAVE_TIMEOUT);
  await expect(saveStatus(page)).toHaveText('Saved', SAVE_TIMEOUT);
  const editId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(appRoot(page)).toHaveAttribute('data-edit-id', editId);
  // The same editor stayed mounted: the text and the caret are still there.
  expect(await editorTexts(page)).toEqual(['Hello from the end-to-end flow']);
  await page.keyboard.type('!');
  await expect(saveStatus(page)).toHaveText('Saved', SAVE_TIMEOUT);
  await expect.poll(async () => JSON.stringify((await storedBrew(page.request, editId)).doc), SAVE_TIMEOUT).toContain('Hello from the end-to-end flow!');
  // The navbar shows the title (the first heading or "Untitled brew") and records the brew.
  await expect(page.getByTestId('brew-title')).toHaveText('Untitled brew');
  expect(await chromeViolations(page)).toEqual([]);

  // Reload: the text comes back from the server.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForEditor(page);
  expect(await editorTexts(page)).toEqual(['Hello from the end-to-end flow!']);
  await expect(page.getByTestId('draft-offer')).toHaveCount(0);

  // Share page from the navbar: the same text, read-only, with a link back to the editor.
  await nav(page).getByRole('button', { name: 'Share' }).click();
  await page.getByTestId('nav-share-view').click();
  await expect(page).toHaveURL(/\/share\/[\w-]+$/, LOAD_TIMEOUT);
  await waitForEditor(page);
  const shareId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(editorRoot(page)).toHaveAttribute('contenteditable', 'false');
  await expect(editorRoot(page)).toHaveAttribute('aria-readonly', 'true');
  await expect(editorRoot(page)).toContainText('Hello from the end-to-end flow!');
  await expect(page.getByTestId('editor-toolbar')).toHaveCount(0);
  await expect(nav(page).getByTestId('nav-edit')).toHaveAttribute('href', `/edit/${editId}`);
  // Typing on the share page changes nothing.
  await editorRoot(page).click();
  await page.keyboard.type('XYZ');
  await expect(editorRoot(page)).not.toContainText('XYZ');
  expect(await chromeViolations(page)).toEqual([]);

  // Print preview: only the pages, one brew page per sheet.
  await page.emulateMedia({ media: 'print' });
  const layout = await printLayout(page);
  expect(layout.visibleChrome).toEqual([]);
  expect(layout.pages).toBeGreaterThan(0);
  const letter = { width: 8.5 * 96, height: 11 * 96 };
  layout.boxes.forEach((box, i) => {
    expect(Math.abs(box.width - letter.width), `page ${i + 1} width`).toBeLessThan(1);
    expect(Math.abs(box.height - letter.height), `page ${i + 1} height`).toBeLessThan(1);
    expect(box.marginTop + box.marginBottom, `page ${i + 1} margins`).toBe(0);
    expect(box.shadow, `page ${i + 1} shadow`).toBe('none');
    // Stacked edge to edge from the top of the printed document: page i starts sheet i.
    expect(Math.abs(box.top - i * letter.height), `page ${i + 1} top`).toBeLessThan(1);
  });
  expect(layout.documentHeight).toBeLessThanOrEqual(layout.pages * letter.height + 1);
  if (browserName === 'chromium') {
    // The real print output (Chromium only): as many sheets as brew pages.
    const pdf = await page.pdf({ format: 'Letter', printBackground: true });
    expect(pdfPageCount(pdf)).toBe(layout.pages);
  }
  await page.emulateMedia({ media: 'screen' });

  // Opening its own share page counted no view (the author).
  expect((await storedBrew(page.request, editId)).views).toBe(0);
  expect(shareId).toMatch(/^[\w-]+$/);
});
