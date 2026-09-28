// P3.7 in real browsers: the metadata dialog on /dev/panels with a stubbed API (theme list,
// delete, lock review). The payload of the last change is shown in data-testid=meta-payload.
// The real API: metadata-api.spec.ts.
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { axeViolations, openPanels, test, transitionsDone } from './helpers';

/** A real PNG (the default thumbnail) for the thumbnail preview to load. */
const THUMBNAIL_PNG = readFileSync(new URL('../../src/ported/metadata/thumbnail.png', import.meta.url));

async function openDialog(page: Page) {
  await page.getByTestId('open-properties').click();
  const dialog = page.getByRole('dialog', { name: 'Properties' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function payload(page: Page): Promise<Record<string, unknown>> {
  return JSON.parse((await page.getByTestId('meta-payload').textContent()) ?? '{}') as Record<string, unknown>;
}

async function expectPayload(page: Page, field: string, expected: Record<string, unknown>) {
  await expect(page.getByTestId('meta-field')).toHaveText(field);
  await expect.poll(() => payload(page)).toEqual(expect.objectContaining(expected));
}

const BASE = {
  title: 'The Wandering Inn',
  description: 'An inn that is never in the same place twice.',
  tags: ['meta:Template', 'system:D&D 5e'],
  lang: 'en',
  theme: '5ePHB',
  published: false,
  thumbnailUrl: '',
};

test('every field reports its save payload', async ({ page }) => {
  await openPanels(page);
  const dialog = await openDialog(page);

  const title = dialog.getByRole('textbox', { name: 'Title' });
  await expect(title).toBeFocused();
  await title.fill('The Wandering Inn, Revised');
  await expectPayload(page, 'title', { ...BASE, title: 'The Wandering Inn, Revised' });

  await dialog.getByRole('textbox', { name: 'Description' }).fill('Rooms, rumours and a cellar.');
  await expectPayload(page, 'description', { description: 'Rooms, rumours and a cellar.' });

  // The preview loads the image, and one that fails to load becomes a "Couldn't load" message: the
  // test serves it, so the preview never depends on the network.
  await page.route('https://example.com/inn.png', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: THUMBNAIL_PNG }));
  await dialog.getByRole('textbox', { name: 'Thumbnail' }).fill('https://example.com/inn.png');
  await expectPayload(page, 'thumbnailUrl', { thumbnailUrl: 'https://example.com/inn.png' });
  await expect(dialog.getByRole('img', { name: 'Thumbnail preview' })).toHaveAttribute('src', 'https://example.com/inn.png');

  const tags = dialog.getByRole('combobox', { name: 'Tags' });
  await tags.fill('type : one-shot');
  await tags.press('Enter');
  await expectPayload(page, 'tags', { tags: ['meta:Template', 'system:D&D 5e', 'type:One-shot'] });
  // A curated suggestion, by keyboard.
  await tags.fill('Ravenl');
  await tags.press('ArrowDown');
  await tags.press('Enter');
  await expectPayload(page, 'tags', { tags: ['meta:Template', 'system:D&D 5e', 'type:One-shot', 'Ravenloft'] });
  await dialog.getByRole('button', { name: 'Remove tag meta:Template' }).click();
  await expectPayload(page, 'tags', { tags: ['system:D&D 5e', 'type:One-shot', 'Ravenloft'] });

  const lang = dialog.getByRole('combobox', { name: 'Language' });
  await lang.fill('');
  await lang.pressSequentially('fr');
  await page.getByRole('option', { name: /^fr/ }).click();
  await expectPayload(page, 'lang', { lang: 'fr' });

  // Theme: static and user themes from GET /api/themes, grouped; the brew itself is left out.
  const theme = dialog.getByRole('combobox', { name: 'Theme' });
  await expect(theme).toHaveValue('5e PHB');
  await theme.click();
  await theme.press('ArrowDown');
  const list = page.getByRole('listbox', { name: 'Theme' });
  await expect(list.getByRole('group', { name: 'Built-in themes' }).getByRole('option')).toHaveCount(2);
  await expect(list.getByRole('group', { name: 'My themes' }).getByRole('option')).toHaveText([/^My Parchment/]);
  await expect(list.getByRole('group', { name: 'Shared themes' }).getByRole('option')).toHaveText(['Starryby dave']);
  await expect(list.getByText('This brew')).toHaveCount(0);
  await list.getByRole('option', { name: /My Parchment/ }).click();
  await expectPayload(page, 'theme', { theme: 'mineTheme001' });
  await expect(theme).toHaveValue('My Parchment (alice)');

  await dialog.getByRole('switch', { name: 'Published' }).check();
  await expectPayload(page, 'published', { published: true });

  const invite = dialog.getByRole('combobox', { name: 'Invited authors' });
  await invite.fill('Dave');
  await invite.press('Enter');
  await expectPayload(page, 'authors', { authors: ['alice', 'bob', 'carol', 'dave'] });
  await dialog.getByRole('button', { name: 'Remove author bob' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove bob as an author?' });
  await confirm.getByRole('button', { name: 'Remove author' }).click();
  await expect(confirm).toBeHidden();
  await expectPayload(page, 'authors', { authors: ['alice', 'carol', 'dave'] });

  // Everything together in the last payload.
  expect(await payload(page)).toEqual({
    title: 'The Wandering Inn, Revised',
    description: 'Rooms, rumours and a cellar.',
    tags: ['system:D&D 5e', 'type:One-shot', 'Ravenloft'],
    lang: 'fr',
    theme: 'mineTheme001',
    published: true,
    thumbnailUrl: 'https://example.com/inn.png',
    authors: ['alice', 'carol', 'dave'],
  });
});

test('invalid input keeps the upstream message and is not reported', async ({ page }) => {
  await openPanels(page);
  const dialog = await openDialog(page);
  const thumbnail = dialog.getByRole('textbox', { name: 'Thumbnail' });
  await thumbnail.fill('not a url');
  await expect(dialog.getByText('Must be a valid URL')).toBeVisible();
  await expect(thumbnail).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('meta-count')).toHaveText('0');
  const theme = dialog.getByRole('combobox', { name: 'Theme' });
  await theme.fill('nope');
  await theme.press('Enter');
  await expect(dialog.getByText('Must be a valid Share URL or a 12-character ID.')).toBeVisible();
  await theme.fill(`${new URL(page.url()).origin}/share/pastedTheme1`);
  await theme.press('Enter');
  await expect(page.getByTestId('meta-field')).toHaveText('theme');
  expect((await payload(page)).theme).toBe('pastedTheme1');
});

test('Escape closes an open list first, then the dialog, and focus returns', async ({ page }) => {
  await openPanels(page);
  const dialog = await openDialog(page);
  const theme = dialog.getByRole('combobox', { name: 'Theme' });
  await theme.focus();
  await theme.press('ArrowDown');
  await expect(theme).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(theme).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('open-properties')).toBeFocused();
});

test('others see the author lists read-only', async ({ page }) => {
  await openPanels(page, { role: 'author' });
  const dialog = await openDialog(page);
  await expect(dialog.getByRole('combobox', { name: 'Invited authors' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Remove author/ })).toHaveCount(0);
  await expect(dialog.getByTestId('author-list').getByRole('link')).toHaveText(['alice', 'bob']);
  await expect(dialog.getByRole('list', { name: 'Invited authors' })).toHaveText('carol');
  await dialog.getByRole('switch', { name: 'Published' }).check();
  expect(await payload(page)).not.toHaveProperty('authors');
});

test('a locked brew shows the reason and can request a review', async ({ page }) => {
  await openPanels(page, { lock: '1' });
  const dialog = await openDialog(page);
  const lock = dialog.getByRole('region', { name: 'This brew is locked' });
  await expect(lock).toContainText('This brew copies copyrighted text.');
  const request = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/api/brews/devEditId001/lock/review'));
  await lock.getByRole('button', { name: 'Request review' }).click();
  await request;
  await expect(lock.getByTestId('review-requested')).toContainText('Review requested on');
});

test('delete asks first, then calls DELETE /api/brews/{editId}', async ({ page }) => {
  await openPanels(page);
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Remove from my brews' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove this brew from your collection?' });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  const request = page.waitForRequest((r) => r.method() === 'DELETE' && r.url().endsWith('/api/brews/devEditId001'));
  await confirm.getByRole('button', { name: 'Remove me' }).click();
  await request;
  await expect(page.getByTestId('deleted')).toHaveText('devEditId001: left');
});

test.describe('axe', () => {
  test('dialog, open lists and the confirm dialog, light and dark', async ({ page }) => {
    await openPanels(page, { lock: '1' });
    const dialog = await openDialog(page);
    expect(await axeViolations(page)).toEqual([]);

    const theme = dialog.getByRole('combobox', { name: 'Theme' });
    await theme.focus();
    await theme.press('ArrowDown');
    await expect(page.getByRole('listbox', { name: 'Theme' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    const tags = dialog.getByRole('combobox', { name: 'Tags' });
    await tags.fill('sys');
    await expect(page.getByRole('listbox', { name: 'Tags' })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await dialog.getByRole('button', { name: 'Remove author bob' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');

    await page.emulateMedia({ colorScheme: 'dark' });
    // Let the colour transitions finish before measuring contrast.
    await transitionsDone(page);
    expect(await axeViolations(page)).toEqual([]);
  });
});
