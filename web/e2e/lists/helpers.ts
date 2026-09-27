// Helpers for the list page specs (web/e2e/lists): accounts with handles and seeded brews on a
// private API (see run-lists.mjs), list readers, axe and overflow checks.
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, test as base, expect as baseExpect, type Locator, type Page, request as apiRequest } from '@playwright/test';

export const expect = baseExpect;
/**
 * A page's first content after a navigation: as long as a navigation (playwright.config.ts). The
 * list pages load a few dozen modules and one API request.
 */
export const LOAD_TIMEOUT = { timeout: 10_000 };
/**
 * Navigations wait for the DOM, not 'load' (every spec then waits for real content): with other
 * lanes' Firefox suites running, Firefox's load event sometimes never came and page.goto hung.
 */
export const DOM_READY = { waitUntil: 'domcontentloaded' } as const;
export const PASSWORD = 'Passw0rd!';

const apiUrl = process.env.HB_API_URL ?? '';
/** A private API behind the Vite proxy (never the humans' :5080 or :8080). */
export const privateApi = /^https?:\/\/[^/]+:\d+/.test(apiUrl) && !/:(5080|8080)(\/|$)/.test(apiUrl);
export const NEEDS_API = 'needs a private API: node e2e/lists/run-lists.mjs';

/** A short unique word (letters and digits; also a search token for the vault). */
export const uid = (): string => `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 7)}`;

export interface Account {
  email: string;
  handle: string;
  /** Signed in as this account (for the browser user: the test context's request, sharing its cookies). */
  request: APIRequestContext;
}

/** Registers a new account through `request`, signs it in there and gives it a unique handle. */
export async function signUp(request: APIRequestContext, baseURL: string, prefix = 'lst'): Promise<Account> {
  const headers = { Origin: baseURL };
  const email = `${prefix}-${uid()}@e2e.test`;
  const registered = await request.post('/api/auth/register', { data: { email, password: PASSWORD }, headers });
  baseExpect(registered.status(), await registered.text()).toBe(200);
  const login = await request.post('/api/auth/login?useCookies=true', { data: { email, password: PASSWORD }, headers });
  baseExpect(login.status(), await login.text()).toBe(200);
  const handle = `${prefix}-${uid()}`;
  const set = await request.put('/api/account/handle', { data: { handle }, headers });
  baseExpect(set.status(), await set.text()).toBe(200);
  return { email, handle, request };
}

/**
 * The specs' test adds `account({ browser? })`: a new account with a unique handle. With
 * `browser: true` it is signed in in the test's own context (the `page` fixture is that user; one
 * per test); otherwise it lives in an API-only request context, disposed after the test. The
 * specs never open extra browser contexts: under load Firefox sometimes hung in newPage.
 */
export const test = base.extend<{ account: (options?: { browser?: boolean; prefix?: string }) => Promise<Account> }>({
  account: async ({ context, baseURL }, use) => {
    const opened: APIRequestContext[] = [];
    let browserUser = false;
    await use(async ({ browser = false, prefix }: { browser?: boolean; prefix?: string } = {}) => {
      if (browser) {
        if (browserUser) throw new Error('only one account per test can be the browser user');
        browserUser = true;
        return signUp(context.request, baseURL!, prefix);
      }
      const request = await apiRequest.newContext({ baseURL });
      opened.push(request);
      return signUp(request, baseURL!, prefix);
    });
    await Promise.all(opened.map((r) => r.dispose().catch(() => undefined)));
  },
});

export interface SeedBrew {
  title: string;
  description?: string;
  tags?: string[];
  published?: boolean;
  /** Number of pages (the API counts doc.content). */
  pages?: number;
  /** Handles, owner first: the others are invited. */
  authors?: string[];
}

export interface CreatedBrew {
  editId: string;
  shareId: string;
  version: number;
}

function docWithPages(pages: number, text: string): object {
  return {
    type: 'doc',
    content: Array.from({ length: Math.max(1, pages) }, (_, i) => ({
      type: 'page',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `${text} (page ${i + 1})` }] }],
    })),
  };
}

export async function createBrew(request: APIRequestContext, baseURL: string, brew: SeedBrew): Promise<CreatedBrew> {
  const meta = {
    title: brew.title,
    description: brew.description ?? '',
    tags: brew.tags ?? [],
    published: brew.published ?? true,
    ...(brew.authors ? { authors: brew.authors } : {}),
  };
  const res = await request.post('/api/brews', { data: { doc: docWithPages(brew.pages ?? 1, brew.title), meta }, headers: { Origin: baseURL } });
  baseExpect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as CreatedBrew;
}

/** Saves the brew unchanged as the context's user (an invited user becomes an author). */
export async function saveAs(request: APIRequestContext, baseURL: string, editId: string): Promise<void> {
  const loaded = await request.get(`/api/brews/edit/${editId}`);
  baseExpect(loaded.status(), await loaded.text()).toBe(200);
  const brew = (await loaded.json()) as { version: number; doc: unknown };
  const saved = await request.put(`/api/brews/${editId}`, { data: { baseVersion: brew.version, doc: brew.doc }, headers: { Origin: baseURL } });
  baseExpect(saved.status(), await saved.text()).toBe(200);
}

declare global {
  interface Window {
    __hbBlobs?: string[];
    __hbDownloads?: string[];
  }
}

/**
 * Records the app's file downloads (call before the navigation): the text of every Blob turned
 * into an object URL goes to window.__hbBlobs.
 *
 * With `blockDownloads`, a click on an <a download href="blob:…"> is also recorded in
 * window.__hbDownloads (its file name) instead of starting a real download. For Firefox on Windows:
 * once a download starts there, Firefox often stops answering Playwright (page.evaluate and
 * download.path() wait until the test times out; its logs show the Windows download-taskbar
 * component failing). What the app does, the file's name and its content, is still checked, and
 * Chromium runs the real download.
 */
export async function captureDownloads(page: Page, { blockDownloads = false } = {}): Promise<void> {
  await page.addInitScript((block: boolean) => {
    const original = URL.createObjectURL.bind(URL);
    window.__hbBlobs = [];
    window.__hbDownloads = [];
    URL.createObjectURL = (object: Blob | MediaSource) => {
      if (object instanceof Blob) void object.text().then((text) => window.__hbBlobs!.push(text));
      return original(object);
    };
    if (!block) return;
    // Anchors inherit click() from HTMLElement: shadow it on HTMLAnchorElement, delegate otherwise.
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download && this.href.startsWith('blob:')) {
        window.__hbDownloads!.push(this.download);
        return;
      }
      HTMLElement.prototype.click.call(this);
    };
  }, blockDownloads);
}

/** The blob texts recorded by captureDownloads, once there are `count` of them. */
export async function capturedBlobs(page: Page, count = 1, options?: { timeout: number }): Promise<string[]> {
  await expect.poll(() => page.evaluate(() => window.__hbBlobs?.length ?? 0), options).toBe(count);
  return page.evaluate(() => window.__hbBlobs ?? []);
}

/** The file names of the blocked downloads, once there are `count` of them. */
export async function blockedDownloads(page: Page, count = 1, options?: { timeout: number }): Promise<string[]> {
  await expect.poll(() => page.evaluate(() => window.__hbDownloads?.length ?? 0), options).toBe(count);
  return page.evaluate(() => window.__hbDownloads ?? []);
}

/** Opens the share view `count` times anonymously (each counts a view). */
export async function addViews(baseURL: string, shareId: string, count: number): Promise<void> {
  const anonymous = await apiRequest.newContext({ baseURL });
  try {
    for (let i = 0; i < count; i++) baseExpect((await anonymous.get(`/api/brews/share/${shareId}`)).status()).toBe(200);
  } finally {
    await anonymous.dispose();
  }
}

/** The authors (handles) of a brew, as its editor sees them; null when the caller can't open it. */
export async function authorsOf(request: APIRequestContext, editId: string): Promise<string[] | null> {
  const res = await request.get(`/api/brews/edit/${editId}`);
  if (res.status() !== 200) return null;
  return ((await res.json()) as { authors: { handle: string }[] }).authors.map((a) => a.handle);
}

/** "alice’s", "james’" (the page's rule). */
export const possessive = (handle: string): string => handle + (handle.endsWith('s') ? '’' : '’s');

/** The titles shown in a user page group, in order. */
export const groupTitles = (page: Page, group: 'published' | 'unpublished' | 'invited'): Promise<string[]> =>
  page.getByTestId(`list-group-${group}`).getByRole('heading', { level: 3 }).allTextContents();

/** The titles in the vault's results, in order. */
export const vaultTitles = (page: Page): Promise<string[]> => page.getByTestId('vault-items').getByRole('heading', { level: 3 }).allTextContents();

export const brewItem = (page: Page, title: string): Locator => page.getByRole('article', { name: title, exact: true });

/**
 * Every axe violation on the page (all impacts), as "rule: target" strings. Legacy mode runs axe
 * in the page itself: the default mode finishes the run in a new blank page, and under load that
 * newPage (or its evaluate) hung in Firefox until the test timed out. The list pages have no
 * iframes, which is all the default mode adds.
 */
export async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

/**
 * Waits until no CSS transition runs (a colour scheme switch fades colours; axe's contrast check
 * must see the final ones). getAnimations() flushes styles, so transitions that a change just
 * started are included.
 */
export async function transitionsDone(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'));
}

/** How far the page (and the shell's scrolling <main>) overflows sideways, in px. */
export function horizontalOverflow(page: Page): Promise<{ document: number; main: number }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const main = document.getElementById('main-content');
    return {
      document: root.scrollWidth - root.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
    };
  });
}

/** Elements (by test id) whose right edge is past the viewport. */
export function offscreen(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const width = document.documentElement.clientWidth;
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && (box.right > width + 0.5 || box.left < -0.5);
      })
      .map((el) => el.dataset.testid ?? el.textContent ?? el.tagName);
  }, selector);
}
