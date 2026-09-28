// The app shell (plan §9): navbar, notices banner, error pages and the sign-in prompt, with the
// API stubbed (page.route), so this spec needs no API server. auth.spec.ts covers the real API.
import { expect, type Page, test } from '@playwright/test';
import { nextTask } from '../clock';
import { allViolations, PAGE_READY, seriousViolations, STUB_ALICE, stubApi, stubNotice } from './helpers';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** /dev/shell loads every dev harness (editor code included): about 7 s in Firefox under load. */
async function openShellDevPage(page: Page) {
  await page.goto('/dev/shell', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'App shell' })).toBeVisible(PAGE_READY);
}

test.describe('navbar', () => {
  test('disclosures work from the keyboard; Tab continues through the bar', async ({ page }) => {
    await stubApi(page);
    await page.goto('/vault');
    await expect(page.getByRole('heading', { level: 1, name: 'Vault' })).toBeVisible();

    // First tab stop: the skip link; then the brand link, then "New".
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(nav(page).getByRole('link', { name: 'The Homebrewery' })).toBeFocused();
    await page.keyboard.press('Tab');
    const newTrigger = nav(page).getByRole('button', { name: 'New' });
    await expect(newTrigger).toBeFocused();

    await page.keyboard.press('Enter');
    const panel = page.getByRole('group', { name: 'New brew' });
    await expect(panel).toBeVisible();
    await expect(newTrigger).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByRole('link', { name: /^New brew/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(panel.getByRole('link', { name: /^Import a brew/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(panel.getByRole('link', { name: /^Brews on this device/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(newTrigger).toBeFocused();

    // Tab out of an open panel continues with the next nav item.
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('group', { name: 'New brew' })).toBeVisible();
    // Through its three links, then out.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('group', { name: 'New brew' })).toBeHidden();
    await expect(nav(page).getByRole('link', { name: 'Vault' })).toBeFocused();
    await expect(nav(page).getByRole('link', { name: 'Vault' })).toHaveAttribute('aria-current', 'page');
  });

  test('the panel sits under its trigger and a press outside closes it', async ({ page }) => {
    await stubApi(page, { me: STUB_ALICE });
    await page.goto('/vault');
    const trigger = nav(page).getByRole('button', { name: 'New' });
    await trigger.click();
    const panel = page.getByRole('group', { name: 'New brew' });
    await expect(panel).toBeVisible();
    const t = await trigger.boundingBox();
    const p = await panel.boundingBox();
    expect(t && p).toBeTruthy();
    if (t && p) {
      expect(p.y).toBeGreaterThanOrEqual(t.y + t.height - 1);
      // Right-aligned with the trigger (bottom-end).
      expect(Math.abs(p.x + p.width - (t.x + t.width))).toBeLessThan(2);
    }
    // At the right edge the account panel is kept inside the viewport.
    await page.keyboard.press('Escape');
    await nav(page).getByRole('button', { name: 'Account: alice' }).click();
    await expect(page.getByRole('group', { name: 'Account' })).toBeVisible();
    const account = await page.getByRole('group', { name: 'Account' }).boundingBox();
    const viewport = page.viewportSize();
    expect(account && viewport).toBeTruthy();
    if (account && viewport) {
      expect(account.x).toBeGreaterThanOrEqual(0);
      expect(account.x + account.width).toBeLessThanOrEqual(viewport.width);
    }
    await page.getByRole('heading', { level: 1 }).click();
    await expect(page.getByRole('group', { name: 'Account' })).toBeHidden();
  });

  test('following a nav link moves focus to the new page heading', async ({ page }) => {
    await stubApi(page, { me: STUB_ALICE });
    await page.goto('/vault');
    await nav(page).getByRole('button', { name: 'Account: alice' }).click();
    await page.getByRole('link', { name: 'Account settings' }).click();
    await expect(page).toHaveURL(/\/account$/);
    const heading = page.getByRole('heading', { level: 1, name: 'Account' });
    await expect(heading).toBeFocused();
    await expect(page).toHaveTitle('Account - The Homebrewery');
  });

  test('recent brews: listed newest first, removable, remembered', async ({ page }) => {
    await stubApi(page);
    const now = Date.now();
    await page.addInitScript(
      ({ now: t }) => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem(
          'hb-recent-brews',
          JSON.stringify({
            edit: [
              { id: 'editNew', title: 'Newest brew', ts: t - 120_000 },
              { id: 'editOld', title: 'Old brew', ts: t - 3 * 86_400_000 },
            ],
            view: [{ id: 'shareA', title: '', ts: t - 3_600_000 }],
          }),
        );
      },
      { now },
    );
    await page.goto('/vault');
    await nav(page).getByRole('button', { name: 'Recent' }).click();
    const panel = page.getByRole('group', { name: 'Recent brews' });
    const edited = panel.getByRole('region', { name: 'Edited' });
    await expect(edited.getByRole('link')).toHaveCount(2);
    await expect(edited.getByRole('link').first()).toHaveAttribute('href', '/edit/editNew');
    await expect(edited.getByRole('link').first()).toContainText('2 minutes ago');
    await expect(panel.getByRole('region', { name: 'Viewed' }).getByRole('link')).toContainText('Untitled brew');

    await edited.getByRole('button', { name: 'Remove Newest brew from recent brews' }).click();
    await expect(edited.getByRole('link')).toHaveCount(1);
    await expect(edited.getByRole('button', { name: 'Remove Old brew from recent brews' })).toBeFocused();

    await page.reload();
    await nav(page).getByRole('button', { name: 'Recent' }).click();
    await expect(page.getByRole('group', { name: 'Recent brews' }).getByRole('region', { name: 'Edited' }).getByRole('link')).toHaveCount(1);

    // A recent entry is a normal link into the app.
    await page.getByRole('link', { name: /Old brew/ }).click();
    await expect(page).toHaveURL(/\/edit\/editOld$/);
  });

  test('narrow screens: icon-only items keep their names', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 800 });
    await stubApi(page, { me: STUB_ALICE });
    await page.goto('/vault');
    await expect(nav(page).getByRole('button', { name: 'Recent' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'The Homebrewery' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await seriousViolations(page)).toEqual([]);
  });
});

test.describe('site notices', () => {
  test('show under the navbar, dismiss one by one, and stay dismissed', async ({ page }) => {
    await stubApi(page, {
      notices: [stubNotice('e2e-maint', 'Maintenance tonight', 'The site will be down for an hour.'), stubNotice('e2e-themes', 'New themes')],
    });
    await page.goto('/vault');
    const region = page.getByRole('region', { name: 'Site notices' });
    await expect(region.getByRole('listitem')).toHaveCount(2);
    await expect(region).toContainText('The site will be down for an hour.');

    await region.getByRole('button', { name: 'Dismiss notice: Maintenance tonight' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(1);
    await expect(region.getByRole('button', { name: 'Dismiss notice: New themes' })).toBeFocused();

    await page.reload();
    await expect(page.getByRole('region', { name: 'Site notices' }).getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Dismiss notice: New themes' }).press('Enter');
    await expect(page.getByRole('region', { name: 'Site notices' })).toBeHidden();
    await expect(page.getByRole('main')).toBeFocused();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('hb-dismissed-notices') ?? '[]') as unknown)).toEqual(['e2e-maint', 'e2e-themes']);
  });
});

test.describe('error pages and prompts', () => {
  test('unknown routes get the not-found page', async ({ page }) => {
    await stubApi(page);
    await page.goto('/no/such/page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page).toHaveTitle('Page not found - The Homebrewery');
    await page.getByRole('link', { name: 'Search the vault' }).click();
    await expect(page).toHaveURL(/\/vault$/);
  });

  test('/account while signed out shows the sign-in form in place, no dialog', async ({ page }) => {
    // Playwright's fake clock (web/e2e/clock.ts): the sign-in dialog opens 150 ms after it is asked
    // for (SIGN_IN_PROMPT_DELAY_MS).
    await page.clock.install();
    await stubApi(page);
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in required' })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
    // Every timer of the next second, then the renders they scheduled: no dialog.
    await page.clock.runFor(1000);
    await nextTask(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/register?returnTo=%2Faccount');
  });

  test('error nav item: explains the failure; "Sign in" opens the sign-in dialog', async ({ page }) => {
    await stubApi(page);
    await openShellDevPage(page);
    const items = page.getByTestId('error-items');
    await items.getByRole('button', { name: /^Oops 409/ }).click();
    const panel = page.getByRole('group', { name: 'Problem saving' });
    await expect(panel).toContainText('Someone saved a newer version of this brew.');
    await expect(panel.getByRole('button', { name: 'Reload the page' })).toBeVisible();
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('last-action')).toHaveText('dismiss 409');

    await items.getByRole('button', { name: /^Oops 500/ }).click();
    await page.getByRole('group', { name: 'Problem saving' }).getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('last-action')).toHaveText('retry 500');
    await expect(items.getByRole('button', { name: /^Oops 500/ })).toBeFocused();

    await items.getByRole('button', { name: /^Oops 401/ }).click();
    await page.getByRole('group', { name: 'Problem saving' }).getByRole('button', { name: 'Sign in' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Email')).toBeFocused();
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(items.getByRole('button', { name: /^Oops 401/ })).toBeFocused();
  });

  test('the lock message page', async ({ page }) => {
    await stubApi(page);
    await openShellDevPage(page);
    await page.getByTestId('error-page-select').selectOption('423');
    const preview = page.getByTestId('error-page-preview');
    await expect(preview.getByRole('heading', { level: 1, name: 'This brew is locked' })).toBeVisible();
    await expect(preview.getByRole('region', { name: 'Why it is locked' })).toContainText('Remove the copied text');
    await expect(preview.getByRole('region', { name: 'Why it is locked' })).toContainText('Lock code 455');
  });
});

test.describe('axe', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [url, heading] of [
      ['/login', 'Sign in'],
      ['/register', 'Create an account'],
      ['/account', 'Sign in required'],
      ['/nope', 'Page not found'],
      ['/vault', 'Vault'],
    ] as const) {
      test(`${url} has no violations, with a notice (${scheme})`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await stubApi(page, { notices: [stubNotice('axe', 'A notice', 'With some text.')] });
        await page.goto(url);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Site notices' })).toBeVisible();
        expect(await allViolations(page)).toEqual([]);
      });
    }

    test(`signed in, with each navbar panel open (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await stubApi(page, { me: { ...STUB_ALICE, roles: ['Admin'] } });
      await page.goto('/account');
      await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
      expect(await allViolations(page)).toEqual([]);
      for (const name of ['New', 'Recent', 'Help', 'Account: alice']) {
        await nav(page).getByRole('button', { name }).click();
        await expect(nav(page).getByRole('button', { name })).toHaveAttribute('aria-expanded', 'true');
        expect(await seriousViolations(page), name).toEqual([]);
        await page.keyboard.press('Escape');
      }
    });
  }

  test('home page', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'The Homebrewery', exact: true })).toBeAttached();
    await expect(page).toHaveTitle('The Homebrewery');
    expect(await seriousViolations(page)).toEqual([]);
  });
});
