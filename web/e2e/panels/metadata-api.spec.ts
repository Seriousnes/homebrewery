// P3.7 against the real API: the theme list of the metadata dialog includes the user's own theme
// brew (GET /api/themes), a chosen user theme saves (PUT /api/brews/{editId} accepts its share id),
// and a server validation error (an unknown invited handle) shows on its field.
//
// Needs a private API (never the humans' :5080/:8080) behind the Vite that Playwright uses:
//
//   dotnet run --project src/Homebrewery.Api --artifacts-path <tmp> --urls http://localhost:5424
//   HB_API_URL=http://localhost:5424 E2E_PORT=5324 npx playwright test e2e/panels/metadata-api.spec.ts
//
// Without HB_API_URL the test is skipped; metadata.spec.ts and MetadataDialog.test.tsx cover the
// dialog with a stubbed API.
import { expect, type Page } from '@playwright/test';
import { openPanels, test } from './helpers';

const apiUrl = process.env.HB_API_URL ?? '';
const privateApi = /^https?:\/\/[^/]+:\d+/.test(apiUrl) && !/:(5080|8080)(\/|$)/.test(apiUrl);

test.skip(!privateApi, 'Needs a private API: HB_API_URL=http://localhost:5424 (see the comment at the top)');
const PASSWORD = 'Passw0rd!e2e-panels';

async function signUp(page: Page, baseURL: string): Promise<string> {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `e2e-panels-${token}@example.com`;
  const headers = { Origin: baseURL };
  const registered = await page.request.post('/api/auth/register', { data: { email, password: PASSWORD }, headers });
  expect(registered.status(), await registered.text()).toBe(200);
  const login = await page.request.post('/api/auth/login?useCookies=true', { data: { email, password: PASSWORD }, headers });
  expect(login.status(), await login.text()).toBe(200);
  return token;
}

async function createBrew(page: Page, baseURL: string, meta: Record<string, unknown>): Promise<{ editId: string; shareId: string; version: number }> {
  const res = await page.request.post('/api/brews', { data: { meta }, headers: { Origin: baseURL } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { editId: string; shareId: string; version: number };
}

test('the theme list has the user’s own theme; choosing it saves; server errors land on their field', async ({ page, baseURL }) => {
  const token = await signUp(page, baseURL!);
  const themeTitle = `E2E Theme ${token}`;
  const theme = await createBrew(page, baseURL!, { title: themeTitle, tags: ['meta:theme'] });
  const brew = await createBrew(page, baseURL!, { title: `E2E Brew ${token}` });

  await openPanels(page, { edit: brew.editId, stubApi: false });
  await expect(page.getByTestId('save-status')).toHaveText(`v${brew.version}`);
  await page.getByTestId('open-properties').click();
  const dialog = page.getByRole('dialog', { name: 'Properties' });
  await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue(`E2E Brew ${token}`);

  // GET /api/themes: the static themes and, under "My themes", the theme brew made above.
  const combobox = dialog.getByRole('combobox', { name: 'Theme' });
  await expect(combobox).toHaveValue('5e PHB');
  await combobox.focus();
  await combobox.press('ArrowDown');
  const list = page.getByRole('listbox', { name: 'Theme' });
  expect(await list.getByRole('group', { name: 'Built-in themes' }).getByRole('option').count()).toBeGreaterThanOrEqual(4);
  const mine = list.getByRole('group', { name: 'My themes' }).getByRole('option', { name: new RegExp(themeTitle) });
  await expect(mine).toHaveAttribute('data-value', theme.shareId);
  await mine.click();
  await expect(page.getByTestId('meta-field')).toHaveText('theme');

  await dialog.getByRole('textbox', { name: 'Title' }).fill(`E2E Brew ${token} renamed`);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // PUT /api/brews/{editId} with the dialog's payload (the server checks meta.theme is a theme brew).
  await page.getByTestId('save-meta').click();
  await expect(page.getByTestId('save-status')).toHaveText(`saved v${brew.version + 1}`);
  const stored = await page.request.get(`/api/brews/edit/${brew.editId}`);
  expect(stored.status()).toBe(200);
  const saved = (await stored.json()) as { meta: { theme: string; title: string } };
  expect(saved.meta).toMatchObject({ theme: theme.shareId, title: `E2E Brew ${token} renamed` });

  // An invited handle nobody has: 400 with errors['meta.authors'], shown on the invite field.
  await page.getByTestId('open-properties').click();
  const invite = dialog.getByRole('combobox', { name: 'Invited authors' });
  await invite.fill(`nobody-${token}`);
  await invite.press('Enter');
  await expect(page.getByTestId('meta-field')).toHaveText('authors');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByTestId('save-meta').click();
  await expect(page.getByTestId('save-status')).toHaveText('save failed');
  await page.getByTestId('open-properties').click();
  await expect(dialog.getByRole('combobox', { name: 'Invited authors' })).toHaveAccessibleDescription(new RegExp(`No user has the handle 'nobody-${token}'`));
});
