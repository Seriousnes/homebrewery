// Helpers for the app shell specs (web/e2e/shell).
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, type PlaywrightWorkerArgs, type Route } from '@playwright/test';

type Playwright = PlaywrightWorkerArgs['playwright'];

export const PASSWORD = 'Passw0rd!';

/** A unique email per call (the shared dev database is never reset). */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@e2e.test`;
}

/**
 * A page whose content needs the dev harnesses or the editor is ready within the navigation's budget
 * (10 s): every /dev page loads every dev harness (about 520 modules from the dev server), about 7 s
 * in Firefox under parallel load.
 */
export const PAGE_READY = { timeout: 10_000 };

/**
 * Axe in legacy mode: axe.run in the page itself. The default mode finishes every analyze() in a new
 * blank page, which took seconds to minutes in Firefox (docs/implementation-notes.md, a11y lane). The
 * shell has no iframes, so the results are the same.
 */
const axe = (page: Page) => new AxeBuilder({ page }).setLegacyMode(true);

/** Axe violations with impact serious or critical. */
export async function seriousViolations(page: Page, include?: string): Promise<string[]> {
  let builder = axe(page);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Every axe violation (the shell aims for none). */
export async function allViolations(page: Page): Promise<string[]> {
  const results = await axe(page).analyze();
  return results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

export interface StubAccount {
  id: string;
  handle: string;
  email: string;
  roles: string[];
}

export const STUB_ALICE: StubAccount = { id: '0190-alice', handle: 'alice', email: 'alice@example.test', roles: [] };

export interface StubNotice {
  id: string;
  dismissKey: string;
  title: string;
  body: string;
  startsAt: string;
  stopsAt: string;
  createdAt: string;
}

export function stubNotice(key: string, title: string, body = ''): StubNotice {
  return {
    id: `id-${key}`,
    dismissKey: key,
    title,
    body,
    startsAt: '2026-01-01T00:00:00Z',
    stopsAt: '2099-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

/**
 * Stub the API for pages that only need the account and the notices: `me` (null: anonymous),
 * the active notices, logout, and 404 problem+json for everything else. No API server needed.
 */
export async function stubApi(page: Page, { me = null, notices = [] }: { me?: StubAccount | null; notices?: StubNotice[] } = {}) {
  let account = me;
  // Only the API: Vite serves modules such as /src/api/client.ts, which must pass through.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route: Route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (url.pathname) {
      case '/api/account/me':
        return account ? json(account) : route.fulfill({ status: 204 });
      case '/api/notifications/active':
        return json(notices);
      case '/api/account/logout':
        account = null;
        return route.fulfill({ status: 204 });
      default:
        return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
    }
  });
}

/** Whether the Vite dev server can reach a real API (HB_API_URL). */
export async function apiIsUp(request: APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get('/api/account/me', { timeout: 5_000 });
    return response.status() === 200 || response.status() === 204;
  } catch {
    return false;
  }
}

/**
 * An API client with its own cookie jar, signed in as `email` (registered first; registering an
 * existing email is a no-op). Writes need an Origin header (SameOriginWriteGuard).
 */
export async function signedInApi(playwright: Playwright, baseURL: string, email: string, password = PASSWORD): Promise<APIRequestContext> {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const register = await api.post('/api/auth/register', { data: { email, password } });
  expect(register.status(), await register.text()).toBe(200);
  const login = await api.post('/api/auth/login?useCookies=true', { data: { email, password } });
  expect(login.status(), await login.text()).toBe(200);
  return api;
}
