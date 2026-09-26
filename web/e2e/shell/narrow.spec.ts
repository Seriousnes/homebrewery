// Phone widths (APP-6, APP-7): the navbar keeps the account item on screen at 320 px (WCAG 1.4.10
// Reflow), and the editor's side panels leave the pages visible: closed by default on a compact
// screen, one at a time, as sheets over the canvas. The API is stubbed (page.route), so this spec
// needs no API server.
import { expect, type Page, test } from '@playwright/test';
import { waitForEditor } from '../flows/helpers';
import { PAGE_READY } from './helpers';

const ALICE = { id: '0190-alice', handle: 'alice-the-brewer', email: 'alice@example.test', roles: [] };
const doc = { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A brew on a phone' }] }] }] };
const meta = { title: 'Phone brew', description: '', tags: [], lang: 'en', theme: '5ePHB', published: true, thumbnailUrl: null };
const times = { createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };

const editBrew = {
  editId: 'editA123456',
  shareId: 'shareA12345',
  version: 3,
  docSchemaVersion: 1,
  doc,
  style: '',
  snippets: null,
  sourceMarkdown: null,
  meta,
  authors: [{ handle: ALICE.handle, role: 'owner' }],
  role: 'owner',
  pageCount: 1,
  views: 0,
  lock: null,
  ...times,
};

// Someone else's brew: the reader gets "Clone".
const shareBrew = { shareId: 'shareB12345', editId: null, docSchemaVersion: 1, doc, style: '', meta, authors: ['bob'], pageCount: 1, views: 7, ...times };

async function stubApi(page: Page) {
  // /share/* documents come from the API (the share shell); without one, serve the app's index.html.
  await page.route(
    (url) => url.pathname.startsWith('/share/'),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch({ url: new URL('/', route.request().url()).href });
      return route.fulfill({ response });
    },
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const { pathname } = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (pathname === '/api/account/me') return json(ALICE);
      if (pathname === '/api/notifications/active') return json([]);
      if (pathname === `/api/brews/edit/${editBrew.editId}`) return json(editBrew);
      if (pathname === `/api/brews/share/${shareBrew.shareId}`) return json(shareBrew);
      return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
    },
  );
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** The nav's overflow and the account trigger's right edge. */
async function navFit(page: Page) {
  return page.evaluate(() => {
    const navElement = document.querySelector('nav[aria-label="Main"]') as HTMLElement;
    const account = navElement.querySelector('[aria-label^="Account:"]') as HTMLElement;
    return {
      overflow: navElement.scrollWidth - navElement.clientWidth,
      accountRight: account.getBoundingClientRect().right,
      viewport: window.innerWidth,
    };
  });
}

test.describe('320 px: the navbar', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const [name, path, item] of [
    ['the editor', `/edit/${editBrew.editId}`, 'nav-share'],
    ["someone else's share page", `/share/${shareBrew.shareId}`, 'nav-clone'],
  ] as const) {
    test(`keeps the account item on screen on ${name}`, async ({ page }) => {
      await stubApi(page);
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(nav(page).getByTestId(item)).toBeVisible(PAGE_READY);
      const account = nav(page).getByRole('button', { name: `Account: ${ALICE.handle}` });
      await expect(account).toBeVisible();
      const fit = await navFit(page);
      expect(fit.overflow).toBeLessThanOrEqual(0);
      expect(fit.accountRight).toBeLessThanOrEqual(fit.viewport);
      // Reachable by pointer: the panel opens and offers "Sign out".
      await account.click();
      await expect(page.getByRole('group', { name: 'Account' }).getByRole('button', { name: 'Sign out' })).toBeVisible();
    });
  }
});

test.describe('390 px: the editor panels', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // The canvas's scroll container (the editor's dev API handle).
  const viewportWidth = (page: Page) =>
    page.evaluate(() => {
      const app = (window as unknown as { __hbEditorApp: { handle: { viewport: HTMLElement } } }).__hbEditorApp;
      return app.handle.viewport.getBoundingClientRect().width;
    });
  const asideBoxes = (page: Page) =>
    page.evaluate(() => [...document.querySelectorAll('aside')].map((aside) => ({ left: aside.getBoundingClientRect().left, right: aside.getBoundingClientRect().right })));

  test('start closed, open one at a time over the pages, and stay on screen', async ({ page }) => {
    await stubApi(page);
    await page.goto(`/edit/${editBrew.editId}`, { waitUntil: 'domcontentloaded' });
    await waitForEditor(page);
    const innerWidth = await page.evaluate(() => window.innerWidth);
    // Nothing open by default: the pages get the width.
    await expect(page.getByTestId('toggle-inspector')).toHaveAttribute('aria-expanded', 'false');
    expect(await page.locator('aside').count()).toBe(0);
    expect(await viewportWidth(page)).toBeGreaterThanOrEqual(innerWidth - 2);

    for (const id of ['outline', 'style', 'inspector'] as const) {
      await page.getByTestId(`toggle-${id}`).click();
      await expect(page.getByTestId(`toggle-${id}`)).toHaveAttribute('aria-expanded', 'true');
      // One at a time, within the screen, over the canvas (which keeps its width).
      const boxes = await asideBoxes(page);
      expect(boxes).toHaveLength(1);
      expect(boxes[0]!.left).toBeGreaterThanOrEqual(0);
      expect(boxes[0]!.right).toBeLessThanOrEqual(innerWidth);
      expect(await viewportWidth(page)).toBeGreaterThanOrEqual(200);
    }

    // What was opened on the phone is not stored: the wide-screen preference stays.
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('hb-ui') ?? 'null') as { state: { panels: Record<string, { open: boolean }> } } | null);
    expect(stored === null || stored.state.panels.inspector?.open === true).toBe(true);
  });
});
