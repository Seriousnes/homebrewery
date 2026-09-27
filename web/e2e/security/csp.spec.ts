// P8.3: the production build under the enforced Content-Security-Policy (src/Homebrewery.Api/Infrastructure/
// SecurityHeaders.cs, docs/security.md). A walk through every page (anonymous, signed in, admin) with brews that use
// what brews use in the wild — theme CSS and fonts, user CSS with an https @import (a web font), https and data:
// images, raw HTML with inline styles — must cause no CSP violation: none reported by a securitypolicyviolation
// listener (every page and frame of the context) and none logged to the console. A canary checks that the policy is
// really enforced and the listener really hears: an inline script, eval and an http: image are blocked and reported.
//
// Runs only against the production host: node e2e/security/run-csp.mjs (from web/). Other hosts send no policy
// (Vite dev), so the spec skips there. Every other origin is stubbed (context.route), so the walk needs no internet;
// requests the policy blocks never reach the stubs.
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from '@playwright/test';

test.skip(!process.env.HB_CSP_E2E, 'Needs the production host: node e2e/security/run-csp.mjs');

const PASSWORD = 'Passw0rd!';
/** A page of the production build (bundled, no dev server): its content within the navigation's budget. */
const LOAD = { timeout: 10_000 };
/** A save the autosave makes: its 3 s delay (AUTOSAVE_DELAY_MS), the settle check and the round trip. */
const SAVE = { timeout: 8_000 };
const ADMIN_EMAIL = process.env.SECURITY_ADMIN_EMAIL ?? 'security-admin@e2e.test';

/** Stand-ins for other sites (brews link images and web fonts from anywhere). */
const IMAGES = 'https://images.csp-e2e.test';
const FONTS = 'https://fonts.csp-e2e.test';
/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_DATA_URI = `data:image/png;base64,${PNG.toString('base64')}`;

interface Violation {
  via: 'event' | 'console';
  page: string;
  directive: string;
  blocked: string;
  source: string;
  sample: string;
}

declare global {
  interface Window {
    __hbCspViolation?: (v: Omit<Violation, 'via' | 'page'>) => void;
  }
}

/**
 * Records CSP violations of every page and frame of `context`: securitypolicyviolation events (an init script in
 * every document reports them through a binding) and console messages about the policy (Chromium also logs the ones
 * of script-less probe frames, where init scripts don't run).
 */
async function watchCsp(context: BrowserContext): Promise<Violation[]> {
  const violations: Violation[] = [];
  await context.exposeBinding('__hbCspViolation', ({ frame }, v: Omit<Violation, 'via' | 'page'>) => {
    violations.push({ via: 'event', page: frame.url(), ...v });
  });
  await context.addInitScript(() => {
    window.addEventListener(
      'securitypolicyviolation',
      (e) => window.__hbCspViolation?.({ directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, sample: e.sample }),
      true,
    );
  });
  context.on('console', (message) => {
    const text = message.text();
    if (/content[- ]security[- ]policy|permissions[- ]policy/i.test(text)) {
      violations.push({ via: 'console', page: message.page()?.url() ?? '', directive: message.type(), blocked: '', source: message.location().url, sample: text });
    }
  });
  return violations;
}

/** Answers every request to another origin: fonts, CSS (with CORS, as fetch and @font-face need) and images. */
async function stubOtherSites(context: BrowserContext, request: APIRequestContext): Promise<void> {
  const font = await request.get('/fonts/5e/Bookinsanity%20Bold.woff2');
  expect(font.status()).toBe(200);
  const fontBytes = await font.body();
  const cors = { 'access-control-allow-origin': '*' };
  await context.route(
    (url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
    async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === FONTS && url.pathname.startsWith('/css2')) {
        await route.fulfill({
          status: 200,
          headers: { ...cors, 'content-type': 'text/css' },
          body: `@font-face { font-family: 'CspTest'; src: url(${FONTS}/csptest.woff2) format('woff2'); }`,
        });
      } else if (/\.(woff2?|ttf|otf)$/.test(url.pathname)) {
        await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'font/woff2' }, body: fontBytes });
      } else if (/\.css$/.test(url.pathname)) {
        await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/css' }, body: '' });
      } else {
        await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/png' }, body: PNG });
      }
    },
  );
}

async function setUp(context: BrowserContext, request: APIRequestContext): Promise<Violation[]> {
  const violations = await watchCsp(context);
  await stubOtherSites(context, request);
  return violations;
}

/** Opens `path` and checks that the document came with the enforced page policy. */
async function visit(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response, path).not.toBeNull();
  const policy = response!.headers()['content-security-policy'] ?? '';
  expect(policy, `${path} policy`).toContain("script-src 'self'");
  expect(policy, `${path} policy`).toContain("frame-ancestors 'none'");
  expect(response!.headers()['content-security-policy-report-only'], path).toBeUndefined();
}

/** Waits for the editor canvas (theme loaded, pagination settled enough to show pages), its fonts and images. */
async function waitForCanvas(page: Page): Promise<void> {
  await expect(page.locator('[data-canvas-status="ready"]').first()).toBeVisible(LOAD);
  await expect(page.locator('.hb-canvas .page').first()).toBeVisible(LOAD);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const pending = Array.from(document.images).filter((img) => !img.complete);
    const loaded = (img: HTMLImageElement) =>
      new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 5000);
      });
    await Promise.all(pending.map(loaded));
  });
}

/** Lets late work (lazy chunks, pagination, fonts, the autosave) finish on the current page. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@e2e.test`;
}

/** Registers `email` if needed and signs in through `request` (a page's request shares the page's cookies). */
async function signInApi(request: APIRequestContext, baseURL: string, email: string): Promise<void> {
  const headers = { Origin: baseURL };
  // An existing account (the admin, on later runs) is answered like a new one (RegisterPrivacy).
  const registered = await request.post('/api/auth/register', { data: { email, password: PASSWORD }, headers });
  expect(registered.status(), await registered.text()).toBe(200);
  const login = await request.post('/api/auth/login?useCookies=true', { data: { email, password: PASSWORD }, headers });
  expect(login.status(), await login.text()).toBe(200);
}

/** A published one-page brew (5ePHB) with https and data: images, raw HTML with a style, and user CSS with an https @import. */
function walkBrew(title: string) {
  const text = (t: string) => ({ type: 'text', text: t });
  return {
    meta: { title, theme: '5ePHB', published: true, description: 'CSP walk' },
    style: [
      `@import url('${FONTS}/css2?family=CspTest');`,
      `.page h1 { font-family: 'CspTest', serif; }`,
      `.page { background-image: url(${IMAGES}/background.png); }`,
      `.page .note { border-image-source: url(${PNG_DATA_URI}); }`,
    ].join('\n'),
    doc: {
      type: 'doc',
      content: [
        {
          type: 'page',
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [text(title)] },
            { type: 'paragraph', content: [text('An https image: '), { type: 'image', attrs: { src: `${IMAGES}/picture.png`, alt: 'Remote' } }] },
            { type: 'paragraph', content: [text('A data: image: '), { type: 'image', attrs: { src: PNG_DATA_URI, alt: 'Inline' } }] },
            { type: 'rawHtml', attrs: { html: `<div class="note" style="color:#58180d;background:url(${IMAGES}/raw.png)"><p>Raw HTML with a style</p></div>` } },
            { type: 'paragraph', content: [text('The end of the walk.')] },
          ],
        },
      ],
    },
  };
}

interface Brew {
  editId: string;
  shareId: string;
}

async function createBrew(request: APIRequestContext, baseURL: string, title: string): Promise<Brew> {
  const res = await request.post('/api/brews', { data: walkBrew(title), headers: { Origin: baseURL } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Brew;
}

async function handleOf(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/account/me');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { handle: string }).handle;
}

/** The brew's pages show its https image, its raw HTML and the web font its user CSS @imports. */
async function expectBrewResources(page: Page): Promise<void> {
  await expect(page.locator('.hb-canvas img[alt="Remote"]')).toHaveJSProperty('complete', true);
  await expect(page.locator('.hb-canvas').getByText('Raw HTML with a style')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'CspTest' && f.status === 'loaded')), LOAD)
    .toBe(true);
}

const saved = (page: Page) => expect(page.getByTestId('save-status-label')).toHaveText('Saved', SAVE);

test('the policy is enforced and violations are heard (canary)', async ({ context, page, request }) => {
  const violations = await setUp(context, request);
  await visit(page, '/');
  await waitForCanvas(page);
  await settle(page);
  expect(violations).toEqual([]);

  // (eval is not probed here: code evaluated through the browser's automation protocol may bypass the eval check.
  // The policy's lack of 'unsafe-eval' is asserted in SecurityHeadersTests.)
  const outcome = await page.evaluate(async (images) => {
    const flags = window as { __hbInlineRan?: boolean; __hbHandlerRan?: boolean };
    const script = document.createElement('script');
    script.textContent = 'window.__hbInlineRan = true;';
    document.head.append(script);
    const button = document.createElement('button');
    button.setAttribute('onclick', 'window.__hbHandlerRan = true');
    document.body.append(button);
    button.click();
    button.remove();
    const load = (src: string) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
      });
    const https = await load(`${images}/allowed.png`);
    const http = await load('http://images.csp-e2e.test/blocked.png');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { inline: flags.__hbInlineRan === true, handler: flags.__hbHandlerRan === true, https, http };
  }, IMAGES);

  expect(outcome).toEqual({ inline: false, handler: false, https: true, http: false });
  const events = violations.filter((v) => v.via === 'event');
  expect(events.map((v) => v.directive).sort()).toEqual(['img-src', 'script-src-attr', 'script-src-elem']);
  expect(events.find((v) => v.directive === 'img-src')?.blocked).toBe('http://images.csp-e2e.test/blocked.png');
});

test('the home page (the welcome brew), a new brew kept on this device, and Brews on this device', async ({ context, page, request }) => {
  const violations = await setUp(context, request);

  await visit(page, '/');
  await waitForCanvas(page);
  await settle(page);
  await visit(page, '/new');
  await waitForCanvas(page);
  await page.locator('.hb-canvas .ProseMirror').click();
  await page.keyboard.type('Typed on /new under the policy.');
  // Signed out: a local brew (issue #4), stored in IndexedDB; the page moves to /local/:localId.
  await expect(page).toHaveURL(/\/local\/[\w-]+$/, LOAD);
  await settle(page);
  await visit(page, '/local');
  await expect(page.getByTestId('local-brew-item')).toHaveCount(1, LOAD);
  await settle(page);

  expect(violations).toEqual([]);
});

test('site pages, signed out: sign-in pages, vault, user page, errors, a share page', async ({ context, page, request, playwright, baseURL }) => {
  // A walk through eight pages, each given time to settle (settle: the load event, then 500 ms).
  test.setTimeout(30_000);
  const violations = await setUp(context, request);
  // A published brew of someone else, for the vault, the user page and the share page.
  const author = await playwright.request.newContext({ baseURL });
  await signInApi(author, baseURL!, uniqueEmail('csp-author'));
  const brew = await createBrew(author, baseURL!, 'CSP walk shared');
  const handle = await handleOf(author);
  await author.dispose();

  for (const path of ['/login', '/register', '/account', '/this-page-does-not-exist', '/share/unknownShare01', `/user/${handle}`]) {
    await visit(page, path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible(LOAD);
    await settle(page);
  }
  await visit(page, '/vault?q=CSP%20walk%20shared');
  await expect(page.getByText('CSP walk shared').first()).toBeVisible(LOAD);
  await settle(page);

  await visit(page, `/share/${brew.shareId}`);
  await waitForCanvas(page);
  await expectBrewResources(page);
  await settle(page);

  expect(violations).toEqual([]);
});

test('signing up and signing in through the forms', async ({ context, page, request }) => {
  const violations = await setUp(context, request);
  const email = uniqueEmail('csp-forms');

  await visit(page, '/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account$/, LOAD);
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible(LOAD);
  await context.clearCookies();
  await visit(page, '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/, LOAD);
  await settle(page);

  expect(violations).toEqual([]);
});

test('editing: typing, autosave, Insert menu, Style drawer, Outline, Properties, reload, share', async ({ context, page, request, baseURL }) => {
  // A walk through six page loads, with an autosave (its 3 s delay) and two more saves on the way.
  test.setTimeout(30_000);
  const violations = await setUp(context, request);
  await signInApi(page.request, baseURL!, uniqueEmail('csp-editor'));
  const brew = await createBrew(page.request, baseURL!, 'CSP walk editing');

  await visit(page, `/edit/${brew.editId}`);
  await waitForCanvas(page);
  await expectBrewResources(page);

  // Typing and the autosave (a PUT to /api).
  await page.locator('.hb-canvas .ProseMirror').getByText('The end of the walk.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed under the policy.');
  await saved(page);

  // Insert menu: a stat block snippet (theme snippets, their classes and images).
  await page.getByTestId('insert-menu').click();
  await page.getByRole('combobox', { name: 'Search snippets' }).fill('stat block');
  await page.getByRole('listbox', { name: 'Snippets' }).getByRole('option').first().click();
  await expect(page.locator('.hb-canvas .monster').first()).toBeVisible(LOAD);
  await page.keyboard.press('ControlOrMeta+s'); // saves at once (the autosave was walked above)
  await saved(page);

  // Style drawer (CodeMirror): typed CSS restyles the canvas through the constructed sheet.
  await page.getByTestId('toggle-style').click();
  const css = page.locator('.cm-content').first();
  await expect(css).toBeVisible(LOAD);
  await css.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n.page p { letter-spacing: 0.01em; }');
  await page.keyboard.press('ControlOrMeta+s');
  await saved(page);
  await page.getByTestId('toggle-style').click();

  // Outline panel and the Properties dialog.
  await page.getByTestId('toggle-outline').click();
  await expect(page.getByRole('navigation', { name: 'Outline' })).toBeVisible(LOAD);
  await page.getByTestId('open-properties').click();
  const properties = page.getByRole('dialog', { name: 'Properties' });
  await expect(properties).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(properties).toBeHidden();
  await settle(page);

  // Reload: the saved brew comes back (fonts, images, user CSS again); then its share page and the author's pages.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForCanvas(page);
  await expect(page.locator('.hb-canvas .ProseMirror')).toContainText('Typed under the policy.');
  await visit(page, `/share/${brew.shareId}`);
  await waitForCanvas(page);
  await expectBrewResources(page);
  await visit(page, `/user/${await handleOf(page.request)}`);
  await expect(page.getByText('CSP walk editing').first()).toBeVisible(LOAD);
  await visit(page, '/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible(LOAD);
  await settle(page);

  expect(violations).toEqual([]);
});

test('Snippets drawer and Download PDF (its layout probe frame, inlined fonts and images, the API render) in the editor and on the share page', async ({ context, page, request, baseURL }) => {
  const violations = await setUp(context, request);
  await signInApi(page.request, baseURL!, uniqueEmail('csp-export'));
  const brew = await createBrew(page.request, baseURL!, 'CSP walk export');

  await visit(page, `/edit/${brew.editId}`);
  await waitForCanvas(page);

  // The Snippets drawer: a brew snippet with a CodeMirror body, saved with the brew.
  await page.getByTestId('toggle-snippets').click();
  const snippets = page.getByRole('complementary', { name: 'Snippets' });
  await expect(snippets).toBeVisible(LOAD);
  await snippets.getByRole('button', { name: 'New snippet' }).click();
  await expect(snippets.getByTestId('snippet-name')).toBeFocused();
  await page.keyboard.type('Walk snippet');
  await snippets.getByTestId('snippet-body').locator('.cm-content').click();
  await page.keyboard.insertText('{{note\n## Under the policy\n}}');
  await expect(snippets.getByRole('option')).toHaveText(['Walk snippet']);
  await saved(page);
  await page.getByTestId('toggle-snippets').click();

  // Download PDF from the editor, then from the share page: the export chunk, the probe iframe, the
  // render (POST /api/export/pdf) and the download.
  for (const path of [null, `/share/${brew.shareId}`]) {
    if (path) {
      await visit(page, path);
      await waitForCanvas(page);
    }
    const button = page.getByTestId('download-pdf');
    await expect(button).toBeEnabled(LOAD);
    const [download] = await Promise.all([page.waitForEvent('download', LOAD), button.click()]);
    expect(download.suggestedFilename()).toBe('CSP walk export.pdf');
    await expect(page.getByText('Downloaded “CSP walk export.pdf”', { exact: true })).toBeVisible(LOAD);
    await settle(page);
  }

  expect(violations).toEqual([]);
});

test('import: the layout probe lays out a pasted brew, and the import is created', async ({ context, page, request, baseURL }) => {
  const violations = await setUp(context, request);
  await signInApi(page.request, baseURL!, uniqueEmail('csp-import'));

  await visit(page, '/import');
  const hbfm = [
    '```css',
    `@import url('${FONTS}/css2?family=CspTest');`,
    '.page h1 { font-family: CspTest; }',
    '```',
    '# Imported under the policy',
    '',
    `![remote](${IMAGES}/imported.png)`,
    '',
    '{{note',
    '##### A note',
    'With text.',
    '}}',
    '',
    '<div style="color:red" onclick="alert(1)">Raw</div>',
    '',
    '\\page',
    '',
    '## Second page',
  ].join('\n');
  await page.locator('textarea[data-testid="import-paste"], [data-testid="import-paste"] textarea').first().fill(hbfm);
  await page.getByTestId('import-paste-preview').click();
  await expect(page.getByTestId('import-check')).toHaveAttribute('data-state', 'done', LOAD);
  await settle(page);
  await page.getByTestId('import-create-button').click();
  await expect(page).toHaveURL(/\/edit\/[\w-]+$/, LOAD);
  await waitForCanvas(page);
  await expect(page.locator('.hb-canvas .ProseMirror')).toContainText('Imported under the policy');
  await settle(page);

  expect(violations).toEqual([]);
});

test('admin pages', async ({ context, page, request, baseURL }) => {
  const violations = await setUp(context, request);
  await signInApi(page.request, baseURL!, ADMIN_EMAIL);
  const brew = await createBrew(page.request, baseURL!, 'CSP walk admin');

  for (const path of ['/admin', '/admin/users', '/admin/brews', `/admin/brews/${brew.shareId}`, '/admin/locks', '/admin/notifications', '/admin/notifications/new']) {
    await visit(page, path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible(LOAD);
    await settle(page);
  }

  expect(violations).toEqual([]);
});
