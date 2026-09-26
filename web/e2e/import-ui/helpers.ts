// Helpers for the import page's end-to-end tests (web/e2e/import-ui; plan §7, P6.1, P6.3).
// Brew texts here are written for these tests (no upstream or book text).
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type Route } from '@playwright/test';

/**
 * A page load, a conversion or the preview's first layout: as long as a navigation
 * (playwright.config.ts). The report brew (90 paragraphs) converts and lays out in about a second.
 */
export const LOAD_TIMEOUT = { timeout: 10_000 };

/** A paragraph of filler (long enough that 90 of them overflow a page's two columns). */
export const filler = (i: number): string =>
  `Paragraph ${i}: the lantern light shivers on wet stone while the party counts the steps down to the flooded gallery below.`;

/** A page of text too long for one page (90 paragraphs fill about three): upstream clips it; here it flows onto new pages. */
export const longPage = (paragraphs = 90): string => Array.from({ length: paragraphs }, (_, i) => filler(i + 1)).join('\n\n');

/**
 * A brew with something for every count of the report (plan §7): metadata (title, description,
 * tags, lang, theme, one snippet), a css block, a variable definition and its use, an HTML
 * comment, a raw HTML element, a tag that loses its attributes (<font>), a class no stylesheet
 * knows, and a second page of `paragraphs` paragraphs that clips upstream.
 */
export const reportBrew = (paragraphs = 90): string =>
  [
  '```metadata',
  'title: The Sunken Vault',
  'description: A short flooded dungeon.',
  'tags:',
  '  - dungeon',
  '  - e2e',
  'lang: en',
  'theme: 5eDMG',
  'snippets:',
  '  - name: The Sunken Vault',
  '    subsnippets:',
  '      - name: Trap note',
  '        gen: "{{note\\n##### Pit trap\\nThe floor gives way.\\n}}"',
  '```',
  '',
  '```css',
  '.vaultGlow { color: #2a6633; }',
  '```',
  '',
  '# The Sunken Vault',
  '',
  '[vaultName]: Drowned Hall',
  '',
  'Welcome to the $[vaultName].',
  '',
  '<!-- a note for the author only -->',
  '',
  '<section class="vaultGlow">Kept as raw HTML</section>',
  '',
  '<font color="red">Red warning</font> {{zzUnknownImportClass Strange glow}}',
  '',
  '\\page',
  '',
  '## The Long Gallery',
  '',
  longPage(paragraphs),
  '',
].join('\n');

export const REPORT_BREW = reportBrew();

/** A small brew: one heading and one paragraph, no metadata. */
export const simpleBrew = (title: string, body = 'Imported words.'): string => `# ${title}\n\n${body}\n`;

/** The share id the upstream stub answers for. */
export const SHARE_ID = 'aBcDeFgHiJ12';

/**
 * Answers GET /api/import/homebrewery/{shareId} (the API's upstream proxy) without any network:
 * `respond` gets the share id. Returns the ids that were asked for.
 */
export async function stubUpstream(page: Page, respond: (shareId: string, route: Route) => Promise<void>): Promise<string[]> {
  const asked: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/import/homebrewery/'),
    async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
      asked.push(id);
      await respond(id, route);
    },
  );
  return asked;
}

export const upstreamText = (text: string) => (_id: string, route: Route) =>
  route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: text });

export const upstreamProblem =
  (status: number, extensions: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  (_id: string, route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/problem+json',
      headers,
      body: JSON.stringify({ title: `Error ${status}`, status, ...extensions }),
    });

export const ACCOUNT = { id: '00000000-0000-4000-8000-000000000001', handle: 'importer', email: 'importer@e2e.test', roles: [] };

/**
 * The whole API stubbed (no private API needed): signed in as ACCOUNT (or anonymous), no notices,
 * static themes; POST /api/brews is refused (tests that create use the real API). Returns the
 * brew requests made.
 */
export async function stubApi(page: Page, { signedIn = true }: { signedIn?: boolean } = {}): Promise<string[]> {
  const brewRequests: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/import/'),
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/brews')) brewRequests.push(`${route.request().method()} ${url.pathname}`);
      if (url.pathname === '/api/account/me') {
        return signedIn
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACCOUNT) })
          : route.fulfill({ status: 204 });
      }
      if (url.pathname === '/api/notifications/active') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 404, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Not found', status: 404 }) });
    },
  );
  return brewRequests;
}

export async function openImport(page: Page): Promise<void> {
  await page.goto('/import', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { level: 1, name: 'Import a brew' })).toBeVisible(LOAD_TIMEOUT);
}

export const report = (page: Page): Locator => page.getByTestId('import-report');

/** The count shown for report item `id` (import-report-<id>). */
export const reportCount = (page: Page, id: string): Locator => page.getByTestId(`import-report-${id}-count`);

/** Pastes `text` and starts the preview. */
export async function pasteAndPreview(page: Page, text: string): Promise<void> {
  await page.getByRole('tab', { name: 'Paste text' }).click();
  await page.getByLabel('Brew text').fill(text);
  await page.getByRole('button', { name: 'Preview the import' }).click();
}

/** Waits for the conversion, the preview's layout and the report's page counts. */
export async function waitForReport(page: Page): Promise<void> {
  await expect(page.getByTestId('import-check')).toHaveAttribute('data-state', 'done', LOAD_TIMEOUT);
  await expect(page.getByTestId('import-preview')).toHaveAttribute('data-settled', 'true', LOAD_TIMEOUT);
  await expect(report(page)).toHaveAttribute('data-layout', 'done', LOAD_TIMEOUT);
}

/**
 * The page count once the report and the preview agree on it twice in a row. The preview settles
 * again when late fonts or images move pages, and the report follows it, so a count read right
 * after the first settle can be stale.
 */
export async function settledPageCount(page: Page): Promise<number> {
  const previewPages = page.locator('[data-testid="import-preview"] .hb-canvas .page');
  let last = -1;
  let result = -1;
  await expect
    .poll(
      async () => {
        const dom = await previewPages.count();
        const shown = Number(await reportCount(page, 'pages').textContent());
        const agreed = dom === shown ? dom : -1;
        result = agreed >= 0 && agreed === last ? agreed : -1;
        last = agreed;
        return result;
      },
      { ...LOAD_TIMEOUT, intervals: [250, 500, 1000] },
    )
    .toBeGreaterThan(0);
  return result;
}

/**
 * Every axe violation outside the preview's brew pages (their content is the author's). Legacy
 * mode runs axe in the page itself: the default mode finishes every run in a new blank page, which
 * costs seconds per scan in Firefox (and under load sometimes never returned); /import has no
 * iframes to miss.
 */
export async function chromeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).setLegacyMode(true).exclude('.hb-canvas .ProseMirror > .page').analyze();
  return results.violations.map((v) => `${v.id} (${v.impact ?? 'unknown'}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
