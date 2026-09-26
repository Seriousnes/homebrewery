// Timeout guard (CLAUDE.md "Tests fail fast", docs/testing.md). Tests must surface a stall in
// seconds, so explicit timeouts are capped:
//   e2e specs and helpers (web/e2e/**)                    60 s
//   unit tests (web/src/**/*.test.*, scripts/, vite/)     15 s
//     and their helper modules (a src file that imports vitest or Testing Library: a
//     vi.setConfig or configure() there applies to every test file that imports it)
// These are hard ceilings with NO exemption: there are no long tests (the user's rule). A test that
// needs more is split into several short tests (e.g. a 1,000-edit fuzz = 20 tests x 50 edits with
// different seeds). There is no opt-in long tier either: no @long tag, no E2E_LONG / HB_LONG switch.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2E_CEILING = 60_000;
const UNIT_CEILING = 15_000;

// A literal number of milliseconds: 90_000, 20 * 60_000, 1_000 + 500.
const LITERAL = String.raw`[0-9][0-9_]*(?:\s*[*+]\s*[0-9][0-9_]*)*`;

// Timeout settings, not timers. Window timers (setTimeout(fn, ms) without a receiver) and option
// names that merely contain "timeout" (timeoutMs, SETTLE_TIMEOUT_MS) are not matched.
const PATTERNS = [
  // test.setTimeout(x), testInfo.setTimeout(x)
  /\b(?:test|testInfo|info|t)\s*\.\s*setTimeout\(\s*([^)]*?)\s*\)/g,
  // `timeout: x` / `timeout = x` (test, describe, expect, waitFor, poll and helper options) and the
  // prefixed settings: testTimeout / hookTimeout (vi.setConfig), asyncUtilTimeout (Testing Library's
  // configure), actionTimeout / navigationTimeout (test.use).
  new RegExp(String.raw`\b(?:test|hook|teardown|action|navigation|asyncUtil)?timeout\s*[:=]\s*(${LITERAL})`, 'gi'),
  // page.setDefaultTimeout(x), page.setDefaultNavigationTimeout(x)
  new RegExp(String.raw`\.setDefault(?:Navigation)?Timeout\(\s*(${LITERAL})\s*\)`, 'g'),
  // A trailing timeout argument after a callback: `}, 120_000);` closing it(…)/beforeAll(…) …
  new RegExp(String.raw`^\s*\}\s*,\s*(${LITERAL})\s*\)`, 'g'),
  // … and the one-line forms: it('x', async () => { … }, 20_000); beforeAll(() => load(), 180_000);
  new RegExp(String.raw`\b(?:it|test|bench|beforeAll|beforeEach|afterAll|afterEach)(?:\.\w+)*\(.*,\s*(${LITERAL})\s*\)\s*;?\s*$`, 'g'),
];

function evaluate(expr: string): number | null {
  const e = expr.replace(/_/g, '').trim();
  if (!/^[0-9]+(\s*[*+]\s*[0-9]+)*$/.test(e)) return null; // non-literal (e.g. a variable): not checked
  return e.split('+').reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f.trim()), 1), 0);
}

/** The literal timeouts one line sets. */
function timeoutsIn(text: string): number[] {
  const values: number[] = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = evaluate(m[1] ?? '');
      if (value !== null) values.push(value);
    }
  }
  return values;
}

function* files(dir: string, accept: (f: string) => boolean): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('test-results')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full, accept);
    else if (accept(full)) yield full;
  }
}

/** A test helper module: it imports vitest or Testing Library (app code never does). */
const isTestHelper = (file: string) => /from ['"](?:vitest|@testing-library\/[\w-]+)['"]/.test(readFileSync(file, 'utf8'));

interface Violation { file: string; line: number; value: number; text: string }

function scan(list: Iterable<string>, ceiling: number): Violation[] {
  const out: Violation[] = [];
  for (const file of list) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const value of timeoutsIn(text)) {
        if (value <= ceiling) continue;
        out.push({ file: path.relative(webDir, file).replace(/\\/g, '/'), line: i + 1, value, text: text.trim().slice(0, 140) });
      }
    });
  }
  return out;
}

const report = (v: Violation[]) => v.map((x) => `${x.file}:${x.line} ${x.value} ms  ${x.text}`).join('\n');

describe('test timeout guard', () => {
  it(`e2e specs and helpers set no timeout above ${E2E_CEILING / 1000} s`, () => {
    const v = scan(files(path.join(webDir, 'e2e'), (f) => /\.(ts|mts|mjs|js)$/.test(f) && !path.basename(f).startsWith('_')), E2E_CEILING);
    expect(v, `\n${report(v)}`).toEqual([]);
  });

  it(`unit tests set no timeout above ${UNIT_CEILING / 1000} s`, () => {
    const unit = [
      ...files(path.join(webDir, 'src'), (f) => /\.test\.(ts|tsx)$/.test(f) || (/\.(ts|tsx)$/.test(f) && isTestHelper(f))),
      ...files(path.join(webDir, 'scripts'), (f) => /\.test\.ts$/.test(f) && !f.endsWith('testTimeouts.test.ts')),
      ...files(path.join(webDir, 'vite'), (f) => /\.test\.ts$/.test(f)),
    ];
    const v = scan(unit, UNIT_CEILING);
    expect(v, `\n${report(v)}`).toEqual([]);
  });

  it('has no long-test tier: no @long tag, no E2E_LONG / HB_LONG switch, no hb-long-timeout exemption', () => {
    const repo = path.resolve(webDir, '..');
    const self = fileURLToPath(import.meta.url);
    const LONG_TIER = /@long\b|\bE2E_LONG\b|\bHB_LONG\b|hb-long-timeout|\w-long['"`]/;
    const hits: string[] = [];
    const check = (file: string) => {
      if (path.resolve(file) === path.resolve(self)) return;
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((text, i) => {
        if (LONG_TIER.test(text)) hits.push(`${path.relative(repo, file).replace(/\\/g, '/')}:${i + 1} ${text.trim().slice(0, 120)}`);
      });
    };
    for (const dir of ['e2e', 'src', 'scripts', 'vite']) {
      for (const f of files(path.join(webDir, dir), (x) => /\.(ts|tsx|mts|mjs|js)$/.test(x))) check(f);
    }
    for (const f of files(path.join(repo, '.github'), (x) => /\.ya?ml$/.test(x))) check(f);
    check(path.join(webDir, 'playwright.config.ts'));
    expect(hits, `\n${hits.join('\n')}`).toEqual([]);
  });

  it('evaluates literal timeout expressions', () => {
    expect(evaluate('120_000')).toBe(120_000);
    expect(evaluate('20 * 60_000')).toBe(1_200_000);
    expect(evaluate('1_000 + 2 * 3')).toBe(1_006);
    expect(evaluate('budget * 2')).toBeNull();
  });

  it('finds every form of timeout setting, and no timers', () => {
    const found: [string, number[]][] = [
      ["describe('x', { timeout: 30_000 }, () => {", [30_000]],
      ['test.setTimeout(90_000);', [90_000]],
      ['testInfo.setTimeout(2 * 60_000);', [120_000]],
      ['vi.setConfig({ testTimeout: 60_000, hookTimeout: 20_000 });', [60_000, 20_000]],
      ["test.use({ navigationTimeout: 90_000, actionTimeout: 30_000 });", [90_000, 30_000]],
      ['configure({ asyncUtilTimeout: 20_000 });', [20_000]],
      ['page.setDefaultTimeout(120_000);', [120_000]],
      ['page.setDefaultNavigationTimeout(90_000);', [90_000]],
      ['}, 180_000);', [180_000]],
      ['  }, 120_000); // the fuzz', [120_000]],
      ["it('x', async () => { await run(); }, 20_000);", [20_000]],
      ['beforeAll(() => preloadAppPages(), 180_000);', [180_000]],
      ["await expect(locator).toBeVisible({ timeout: 45_000 });", [45_000]],
      ['const { timeout = 70_000 } = options;', [70_000]],
    ];
    for (const [line, values] of found) expect(timeoutsIn(line), line).toEqual(values);
    for (const line of [
      'setTimeout(resolve, 20_000);',
      'await new Promise((r) => setTimeout(r, 30_000));',
      'fetchDataUri(url, { timeoutMs: 90_000 });',
      'export const SETTLE_TIMEOUT_MS = 90_000;',
      'test.setTimeout(budget * 2);',
      "it('parses', () => expect(parse('1,000')).toBe(1000));",
      'tr.split(at, 20_000);',
    ]) {
      expect(timeoutsIn(line), line).toEqual([]);
    }
  });
});
