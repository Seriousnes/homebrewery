// /user/:handle against a real API (plan §9, P7.3): what visitors and the owner see, upstream's
// client-side sort and filter (in the URL), and the brew actions (share link, edit, clone,
// download as PDF, delete / remove / decline). Run with node e2e/lists/run-lists.mjs. The PDF is
// rendered by the API's Chromium (the Microsoft.Playwright build).
import { readFile } from 'node:fs/promises';
import {
  addViews,
  authorsOf,
  axeViolations,
  blockedDownloads,
  capturedBlobs,
  captureDownloads,
  brewItem,
  createBrew,
  DOM_READY,
  expect,
  groupTitles,
  horizontalOverflow,
  LOAD_TIMEOUT,
  NEEDS_API,
  offscreen,
  possessive,
  privateApi,
  saveAs,
  test,
} from './helpers';

test.skip(!privateApi, NEEDS_API);

test('a visitor sees the published brews; sort, filter and tags follow the URL and survive a reload', async ({ account, page, baseURL }) => {
  const owner = await account();
  const [, bees] = await Promise.all([
    createBrew(owner.request, baseURL!, { title: 'Aardvark Almanac', pages: 1, tags: ['type:Adventure', 'forest'], description: 'Tiny beasts' }),
    createBrew(owner.request, baseURL!, { title: 'Bestiary of Bees', pages: 3, tags: ['forest'] }),
    createBrew(owner.request, baseURL!, { title: 'Cavern Codex', pages: 2, tags: ['type:Adventure', 'cave'] }),
    createBrew(owner.request, baseURL!, { title: 'Secret Draft', published: false }),
  ]);
  await addViews(baseURL!, bees.shareId, 2);

  await page.goto(`/user/${owner.handle}`, DOM_READY);
  await expect(page.getByTestId('list-page')).toBeVisible(LOAD_TIMEOUT);
  await expect(page.getByRole('heading', { level: 1, name: `${possessive(owner.handle)} brews` })).toBeVisible();
  await expect(page).toHaveTitle(`${possessive(owner.handle)} brews - The Homebrewery`);
  expect(await groupTitles(page, 'published')).toEqual(['Aardvark Almanac', 'Bestiary of Bees', 'Cavern Codex']);
  await expect(page.getByText('Secret Draft')).toHaveCount(0);
  await expect(page.getByTestId('list-group-unpublished')).toHaveCount(0);
  await expect(page.getByTestId('brew-edit')).toHaveCount(0);
  await expect(page.getByTestId('brew-clone')).toHaveCount(0);
  const bestiary = brewItem(page, 'Bestiary of Bees');
  await expect(bestiary.getByTestId('brew-pages')).toHaveText('3 pages');
  await expect(bestiary.getByTestId('brew-views')).toHaveText('2 views');
  await expect(bestiary.getByRole('link', { name: owner.handle })).toHaveAttribute('href', `/user/${owner.handle}`);
  await expect(bestiary.getByRole('link', { name: 'Bestiary of Bees' })).toHaveAttribute('href', `/share/${bees.shareId}`);

  const sortBar = page.getByRole('group', { name: 'Sort by' });
  await sortBar.getByRole('button', { name: /^Pages/ }).click();
  await expect(sortBar.getByRole('button', { name: /^Pages/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await groupTitles(page, 'published')).toEqual(['Bestiary of Bees', 'Cavern Codex', 'Aardvark Almanac']);
  await expect(page).toHaveURL(/[?&]sort=pages&dir=desc/);

  await page.getByRole('searchbox', { name: 'Filter' }).fill('codex');
  await expect(page.getByTestId('list-count')).toHaveText('Showing 1 of 3 brews');
  expect(await groupTitles(page, 'published')).toEqual(['Cavern Codex']);
  await expect(page).toHaveURL(/[?&]filter=codex/);
  await page.getByRole('searchbox', { name: 'Filter' }).fill('');

  await bestiary.getByRole('button', { name: 'forest', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove the tag filter forest' })).toBeVisible();
  await expect.poll(() => groupTitles(page, 'published')).toEqual(['Bestiary of Bees', 'Aardvark Almanac']);
  await expect(page).toHaveURL(/[?&]tag=forest/);
  expect(new URL(page.url()).searchParams.get('filter')).toBeNull();

  await page.reload(DOM_READY);
  await expect(page.getByTestId('list-page')).toBeVisible(LOAD_TIMEOUT);
  await expect(page.getByRole('group', { name: 'Sort by' }).getByRole('button', { name: /^Pages/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Remove the tag filter forest' })).toBeVisible();
  expect(await groupTitles(page, 'published')).toEqual(['Bestiary of Bees', 'Aardvark Almanac']);

  await page.getByRole('button', { name: 'Remove the tag filter forest' }).click();
  await expect.poll(() => groupTitles(page, 'published')).toHaveLength(3);
  expect(await axeViolations(page)).toEqual([]);
});

test('the owner sees every group; Edit links; Delete removes the brew', async ({ account, page, baseURL }) => {
  const [alice, bob] = await Promise.all([account({ browser: true }), account()]);
  const [own] = await Promise.all([
    createBrew(alice.request, baseURL!, { title: 'Mine to delete' }),
    createBrew(alice.request, baseURL!, { title: 'Unpublished notes', published: false, pages: 2 }),
  ]);
  const [shared] = await Promise.all([
    createBrew(bob.request, baseURL!, { title: 'Shared campaign', authors: [bob.handle, alice.handle] }),
    createBrew(bob.request, baseURL!, { title: 'Invitation brew', published: false, authors: [bob.handle, alice.handle] }),
  ]);
  await saveAs(alice.request, baseURL!, shared.editId); // alice accepts: invited → author

  await page.goto(`/user/${alice.handle}`, DOM_READY);
  await expect(page.getByRole('heading', { level: 1, name: 'Your brews' })).toBeVisible(LOAD_TIMEOUT);
  expect(await groupTitles(page, 'published')).toEqual(['Mine to delete', 'Shared campaign']);
  expect(await groupTitles(page, 'unpublished')).toEqual(['Unpublished notes']);
  expect(await groupTitles(page, 'invited')).toEqual(['Invitation brew']);
  await expect(page.getByRole('link', { name: 'Edit Mine to delete' })).toHaveAttribute('href', `/edit/${own.editId}`);
  await expect(brewItem(page, 'Shared campaign').getByRole('link', { name: bob.handle })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Delete (the only author): gone for good; focus moves to the next brew.
  await page.getByRole('button', { name: 'Delete Mine to delete' }).click();
  const confirmDelete = page.getByRole('alertdialog', { name: 'Delete “Mine to delete”?' });
  await expect(confirmDelete).toBeVisible();
  await confirmDelete.getByRole('button', { name: 'Delete brew' }).click();
  await expect(confirmDelete).toBeHidden();
  await expect.poll(() => groupTitles(page, 'published')).toEqual(['Shared campaign']);
  await expect(page.getByRole('link', { name: 'Shared campaign', exact: true })).toBeFocused();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('“Mine to delete” was deleted.');
  expect(await authorsOf(alice.request, own.editId)).toBeNull();
});

test('Download gives the stored brew as a PDF, one sheet per page', async ({ account, page, browserName, baseURL }) => {
  const alice = await account({ browser: true });
  await createBrew(alice.request, baseURL!, { title: 'Unpublished notes', published: false, pages: 2 });

  // A real download in Chromium; in Firefox the app's download is recorded, not started (see captureDownloads).
  const realDownload = browserName === 'chromium';
  await captureDownloads(page, { blockDownloads: !realDownload });
  await page.goto(`/user/${alice.handle}`, DOM_READY);
  const downloadButton = page.getByRole('button', { name: 'Download Unpublished notes as PDF' });
  await expect(downloadButton).toBeVisible(LOAD_TIMEOUT);

  // The browser exports the stored brew (no view counted: the editor endpoint), the API renders it.
  let pdf: string;
  if (realDownload) {
    const [download] = await Promise.all([page.waitForEvent('download', LOAD_TIMEOUT), downloadButton.click()]);
    expect(download.suggestedFilename()).toBe('Unpublished notes.pdf');
    pdf = await readFile(await download.path(), 'latin1');
  } else {
    await downloadButton.click();
    expect(await blockedDownloads(page, 1, LOAD_TIMEOUT)).toEqual(['Unpublished notes.pdf']);
    pdf = (await capturedBlobs(page, 1, LOAD_TIMEOUT))[0]!;
  }
  expect(pdf.startsWith('%PDF-')).toBe(true);
  expect(pdf.match(/\/Type\s*\/Page(?![a-zA-Z])/g)).toHaveLength(2);
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Downloaded “Unpublished notes.pdf”');
});

test('Remove leaves a co-authored brew to its other author; Decline drops an invitation', async ({ account, page, baseURL }) => {
  const [alice, bob] = await Promise.all([account({ browser: true }), account()]);
  const [shared, invite] = await Promise.all([
    createBrew(bob.request, baseURL!, { title: 'Shared campaign', authors: [bob.handle, alice.handle] }),
    createBrew(bob.request, baseURL!, { title: 'Invitation brew', published: false, authors: [bob.handle, alice.handle] }),
    createBrew(alice.request, baseURL!, { title: 'Unpublished notes', published: false }),
  ]);
  await saveAs(alice.request, baseURL!, shared.editId); // alice accepts: invited → author

  await page.goto(`/user/${alice.handle}`, DOM_READY);
  await expect(page.getByRole('heading', { level: 1, name: 'Your brews' })).toBeVisible(LOAD_TIMEOUT);

  await page.getByRole('button', { name: 'Remove Shared campaign' }).click();
  const confirmRemove = page.getByRole('alertdialog', { name: 'Remove “Shared campaign” from your brews?' });
  await expect(confirmRemove).toContainText('You stop being one of its authors. The other authors keep the brew.');
  await confirmRemove.getByRole('button', { name: 'Remove me' }).click();
  await expect(confirmRemove).toBeHidden();
  await expect(page.getByTestId('list-group-published').getByText('No published brews.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('You are no longer an author of “Shared campaign”.');
  expect(await authorsOf(bob.request, shared.editId)).toEqual([bob.handle]);

  await page.getByRole('button', { name: 'Decline Invitation brew' }).click();
  await page.getByRole('alertdialog', { name: 'Decline the invitation to “Invitation brew”?' }).getByRole('button', { name: 'Decline invitation' }).click();
  await expect(page.getByTestId('list-group-invited')).toHaveCount(0);
  expect(await authorsOf(bob.request, invite.editId)).toEqual([bob.handle]);
  expect(await groupTitles(page, 'unpublished')).toEqual(['Unpublished notes']);
});

test("a signed-in reader clones someone else's brew and copies share links", async ({ account, context, page, browserName, baseURL }) => {
  const [alice, bob] = await Promise.all([account(), account({ browser: true })]);
  const source = await createBrew(alice.request, baseURL!, { title: 'Clone source', pages: 2 });
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });

  await page.goto(`/user/${alice.handle}`, DOM_READY);
  await expect(page.getByTestId('list-page')).toBeVisible(LOAD_TIMEOUT);
  // Other people's brews: no Edit, Download or Delete.
  await expect(page.getByTestId('brew-edit')).toHaveCount(0);
  await expect(page.getByTestId('brew-remove')).toHaveCount(0);

  const shareUrl = `${baseURL}/share/${source.shareId}`;
  await page.getByRole('button', { name: 'Copy link to Clone source' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText(shareUrl, { exact: true })).toBeVisible();
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shareUrl);

  await page.getByRole('button', { name: 'Clone Clone source' }).click();
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, LOAD_TIMEOUT);
  const copyEditId = new URL(page.url()).pathname.split('/').pop()!;
  expect(copyEditId).not.toBe(source.editId);
  const bobs = await bob.request.get(`/api/users/${bob.handle}/brews`);
  const list = (await bobs.json()) as { items: { editId: string; pageCount: number }[] };
  expect(list.items.map((b) => b.editId)).toEqual([copyEditId]);
  expect(list.items[0]!.pageCount).toBe(2);
});

test('works from the keyboard: sort, group toggle, tag filter and the delete dialog', async ({ account, page, baseURL }) => {
  const alice = await account({ browser: true });
  await Promise.all([
    createBrew(alice.request, baseURL!, { title: 'First brew', tags: ['keyboard'] }),
    createBrew(alice.request, baseURL!, { title: 'Second brew' }),
  ]);
  await page.goto(`/user/${alice.handle}`, DOM_READY);
  await expect(page.getByRole('heading', { level: 1, name: 'Your brews' })).toBeVisible(LOAD_TIMEOUT);

  // Filter box → Shift+Tab → the last sort button (Pages); Enter picks it.
  await page.getByRole('searchbox', { name: 'Filter' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: /^Pages/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^Pages/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: /^Views/ })).toHaveAttribute('aria-pressed', 'true');

  // The group heading is a disclosure button.
  const toggle = page.getByRole('button', { name: /^Your published brews/ });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // A tag toggles a filter; the filter chip removes it.
  await brewItem(page, 'First brew').getByRole('button', { name: 'keyboard' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove the tag filter keyboard' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('article')).toHaveCount(2);

  // Delete: Escape cancels (focus returns), then confirm from the keyboard.
  const remove = page.getByRole('button', { name: 'Delete First brew' });
  await remove.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Delete “First brew”?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(remove).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Delete brew' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Second brew', exact: true })).toBeFocused();
});

test.describe('on a phone in dark mode', () => {
  // Context options, not runtime changes before the navigation.
  test.use({ viewport: { width: 320, height: 720 }, colorScheme: 'dark' });

  test('fits a phone (320 px) and passes axe in dark mode', async ({ account, page, baseURL }) => {
    const alice = await account({ browser: true });
    await createBrew(alice.request, baseURL!, {
      title: 'Pneumonoultramicroscopicsilicovolcanoconiosis-hyphenated-title-with-no-spaces',
      description: 'Supercalifragilisticexpialidocious-and-unbreakable-description-text-that-must-wrap-anywhere',
      tags: ['type:Adventure', 'system:D&D 5e', 'a-very-long-tag-without-any-spaces-at-all-in-it'],
    });
    await createBrew(alice.request, baseURL!, { title: 'Draft', published: false });
    await page.goto(`/user/${alice.handle}?tag=type:Adventure`, DOM_READY);
    await expect(page.getByRole('heading', { level: 1, name: 'Your brews' })).toBeVisible(LOAD_TIMEOUT);
    await expect(page.getByRole('article')).toHaveCount(1);
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0 });
    expect(await offscreen(page, '[data-testid^="brew-"], [data-testid^="list-"], button')).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);

    await page.getByRole('button', { name: /^Delete Pneumono/ }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0 });
    expect(await axeViolations(page)).toEqual([]);
  });
});

test('unknown handles show the not-found page', async ({ page }) => {
  await page.goto(`/user/nobody-${Date.now().toString(36)}`, DOM_READY);
  await expect(page.getByRole('heading', { level: 1, name: 'User not found' })).toBeVisible(LOAD_TIMEOUT);
  await expect(page.getByRole('link', { name: /vault/i }).first()).toBeVisible();
});
