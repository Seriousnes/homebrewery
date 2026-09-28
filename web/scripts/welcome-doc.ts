// Converts upstream's welcome brew once into the home page's bundled document (plan §9: "bundled
// doc JSON, converted once from welcome_msg.md"). From web/:
//
//   pnpm exec tsx scripts/welcome-doc.ts            # writes src/pages/home/welcome.doc.json
//   pnpm exec tsx scripts/welcome-doc.ts --check    # exits 1 when the committed file is stale
//
// Options: --url <origin> (use a running dev server), --port <n> (default $E2E_PORT or 5329; the
// script starts Vite there with e2e/flows/vite.isolated.config.mjs), --headed.
//
// The import pipeline (hbfmToDoc: HBFM renderer, sanitizer, lifting with the theme's real layout)
// needs a browser, so this drives Chromium on /dev/import, whose window.__hbImportApi runs it.
// API requests are answered 404 in the page, so themes come from the static catalog. Only sizes
// are printed, never the text.
import type { ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { DOC_SCHEMA_VERSION } from '../src/editor/schema/version.ts';
import { isHumanPort, TestRunner } from './testRunner.ts';
import { MAX_SLOT, slotPort } from './worktree.ts';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webDir, '..');
const WELCOME_SOURCE = 'legacy/client/homebrew/pages/homePage/welcome_msg.md';
const WELCOME_OUTPUT = 'src/pages/home/welcome.doc.json';
const WELCOME_THEME = '5ePHB';

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
};
const check = process.argv.includes('--check');
const headed = process.argv.includes('--headed');
const port = Number(arg('--port') ?? process.env.E2E_PORT ?? slotPort(5329));
if (isHumanPort(port)) {
  console.error(`Refusing a port humans use (5080, 5173, the dev stacks' 8080-${8080 + MAX_SLOT}).`);
  process.exit(2);
}

/** What the home page bundles (web/src/pages/home/welcomeBrew.ts WelcomeDocFile). */
interface WelcomeDocFile {
  source: string;
  generator: string;
  docSchemaVersion: number;
  theme: string;
  lang: string;
  title: string;
  style: string;
  doc: unknown;
}

interface ImportResult {
  doc: unknown;
  style: string;
  meta: { title?: string; theme?: string; lang?: string };
  report: { pages: number; theme: string; warnings: string[]; lost: string[] };
}

/** Serialized the same way every time (the --check comparison relies on it). */
function serializeWelcome(file: WelcomeDocFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

const runner = new TestRunner('welcome-doc');

/** A dev server: the one --url names, one already on the port, or an isolated Vite (at most 30 s to start). */
async function startVite(): Promise<{ origin: string; child: ChildProcess | null }> {
  const given = arg('--url');
  if (given) return { origin: given.replace(/\/$/, ''), child: null };
  const { child, url } = await runner.startVite({ port: String(port), config: 'e2e/flows/vite.isolated.config.mjs' });
  return { origin: url, child };
}

async function convert(origin: string, markdown: string): Promise<ImportResult> {
  const browser = await chromium.launch({ headless: !headed });
  try {
    const page = await browser.newPage();
    // Static themes: never ask an API (whichever one the dev server proxies to).
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"title":"Not found","status":404}' }),
    );
    await page.goto(`${origin}/dev/import`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => Boolean((globalThis as { __hbImportApi?: unknown }).__hbImportApi), undefined, { timeout: 30_000 });
    return await page.evaluate(
      async ({ text, theme }) => {
        type Api = { hbfmToDoc: (text: string, options: { theme: string }) => Promise<ImportResult> };
        const api = (globalThis as unknown as { __hbImportApi: Api }).__hbImportApi;
        const result = await api.hbfmToDoc(text, { theme });
        return {
          doc: result.doc,
          style: result.style,
          meta: { title: result.meta.title, theme: result.meta.theme, lang: result.meta.lang },
          report: { pages: result.report.pages, theme: result.report.theme, warnings: result.report.warnings, lost: result.report.lost },
        };
      },
      { text: markdown, theme: WELCOME_THEME },
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const markdown = readFileSync(path.join(repoRoot, WELCOME_SOURCE), 'utf8');
  const { origin, child } = await startVite();
  let result: ImportResult;
  try {
    result = await convert(origin, markdown);
  } finally {
    await runner.stop(child);
  }
  const file: WelcomeDocFile = {
    source: WELCOME_SOURCE,
    generator: 'web/scripts/welcome-doc.ts (hbfmToDoc, variables expanded)',
    docSchemaVersion: DOC_SCHEMA_VERSION,
    theme: result.meta.theme || result.report.theme || WELCOME_THEME,
    lang: result.meta.lang || 'en',
    title: result.meta.title ?? '',
    style: result.style,
    doc: result.doc,
  };
  const text = serializeWelcome(file);
  const outPath = path.join(webDir, WELCOME_OUTPUT);
  console.log(
    `welcome brew: ${markdown.length} characters → ${result.report.pages} pages, ${text.length} bytes of JSON; ` +
      `${result.report.warnings.length} import warnings, ${result.report.lost.length} lost items; theme ${file.theme}`,
  );
  if (check) {
    let current = '';
    try {
      current = readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      // missing: stale
    }
    if (current !== text) {
      console.error(`${WELCOME_OUTPUT} is stale: run pnpm exec tsx scripts/welcome-doc.ts`);
      process.exit(1);
    }
    console.log(`${WELCOME_OUTPUT} is up to date.`);
    return;
  }
  writeFileSync(outPath, text);
  console.log(`wrote ${WELCOME_OUTPUT}`);
}

try {
  await main();
} catch (error) {
  runner.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  await runner.exit(1);
}
await runner.exit(0);
