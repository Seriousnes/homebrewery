// Writes the S3 fidelity fixtures (plan §7, S3) to web/e2e/fixtures/:
//
//   welcome.hbfm.txt                   legacy/client/homebrew/pages/homePage/welcome_msg.md
//   snippet-<theme>-<group>-<name>…    one per V3 theme snippet generator (themes/V3/*/snippets.js)
//   md-<file>-<nnn>-<case>…            one per case in tests/markdown/*.test.js
//   fixtures.json                      the list, with where each fixture came from
//
// Run from web/:  npx tsx scripts/fidelity-fixtures.ts
//
// Generators use lodash's random helpers (_.sample, _.random, …). lodash captures Math.random
// when it loads, so a seeded PRNG is installed before anything imports lodash and re-seeded
// (from the snippet's name) before each generator runs: the output is the same on every run.
// Theme snippet modules read window.location.origin at import time; it is '' here, so their
// image URLs are site-relative (/assets/…) and load from the dev server.
//
// The tests/markdown files are loaded with stub describe/it/test/expect and a capturing hbfm
// (a virtual 'marked-hbfm' module): every hbfm.render(source, page) call of a case is
// recorded, and the last full pass over its pages becomes the fixture.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Plugin } from 'vite';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webDir, '..');
const themesDir = path.join(repoRoot, 'themes');
// `--out <dir>` writes elsewhere (e.g. to check that a second run gives identical files).
const outArg = process.argv.indexOf('--out');
const outValue = outArg >= 0 ? process.argv[outArg + 1] : undefined;
const outDir = outValue ? path.resolve(outValue) : path.join(webDir, 'e2e', 'fixtures');

// ---------------------------------------------------------------------------------------------
// Deterministic randomness (installed before lodash loads)
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (text: string): number => createHash('sha256').update(text).digest().readUInt32LE(0);
let rng = mulberry32(seedOf('homebrewery-fidelity'));
Math.random = () => rng();
const reseed = (key: string) => {
  rng = mulberry32(seedOf(key));
};

// Theme snippet modules read window.location.origin at import time.
(globalThis as Record<string, unknown>).window = { location: { origin: '' } };

// ---------------------------------------------------------------------------------------------
// Capture of hbfm.render calls (tests/markdown)
// ---------------------------------------------------------------------------------------------

interface RenderCall {
  source: string;
  page: number;
}
let calls: RenderCall[] = [];
(globalThis as Record<string, unknown>).__hbFixtureCapture = {
  render(source: string, page = 0): string {
    calls.push({ source, page });
    return '';
  },
};

const VIRTUAL_HBFM = '\0hb-fixture-hbfm';
const captureHbfm: Plugin = {
  name: 'hb-fixture-capture-hbfm',
  enforce: 'pre',
  resolveId(id) {
    return id === 'marked-hbfm' ? VIRTUAL_HBFM : undefined;
  },
  load(id) {
    if (id !== VIRTUAL_HBFM) return undefined;
    return [
      'const capture = globalThis.__hbFixtureCapture;',
      'export const hbfm = { render: (s, p) => capture.render(s, p), validate: () => [], marked: {} };',
    ].join('\n');
  },
};

interface TestCase {
  file: string;
  title: string;
  pages: string[];
}
const cases: TestCase[] = [];
let currentFile = '';
const describeStack: string[] = [];

function runCase(title: string, fn: () => unknown) {
  calls = [];
  try {
    fn();
  } catch {
    // The stub expect never throws; anything else is the case's own problem.
  }
  if (!calls.length) return;
  // Split the calls into passes (a pass starts at page 0), keep the last one.
  const passes: RenderCall[][] = [];
  for (const call of calls) {
    if (call.page === 0 || !passes.length) passes.push([]);
    passes[passes.length - 1]!.push(call);
  }
  const last = passes[passes.length - 1]!;
  cases.push({ file: currentFile, title: [...describeStack, title].join(' › '), pages: last.map((c) => c.source) });
}

const chain: unknown = new Proxy(() => chain, { get: () => chain, apply: () => chain });
const g = globalThis as Record<string, unknown>;
const describe = (title: string, fn: () => void) => {
  describeStack.push(title);
  try {
    fn();
  } finally {
    describeStack.pop();
  }
};
const it = (title: string, fn: () => unknown) => runCase(title, fn);
for (const f of [describe, it] as unknown as Array<Record<string, unknown>>) {
  f.failing = f;
  f.skip = () => undefined;
  f.only = f;
  f.each = () => () => undefined;
}
g.describe = describe;
g.it = it;
g.test = it;
g.expect = () => chain;
for (const hook of ['beforeEach', 'afterEach', 'beforeAll', 'afterAll']) g[hook] = () => undefined;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const slug = (text: string, max = 48): string =>
  text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, max)
    .replace(/-$/, '') || 'x';

interface FixtureInfo {
  name: string;
  kind: 'welcome' | 'snippet' | 'markdown-test' | 'case';
  source: string;
  /** Theme the fixture renders with (the brew's metadata, default 5ePHB). */
  theme: string;
  note?: string;
}

const fixtures: FixtureInfo[] = [];
const used = new Set<string>();

function writeFixture(info: Omit<FixtureInfo, 'name'> & { base: string }, text: string) {
  let name = info.base;
  for (let i = 2; used.has(name); i++) name = `${info.base}-${i}`;
  used.add(name);
  const { base: _base, ...rest } = info;
  fixtures.push({ name, ...rest });
  writeFileSync(path.join(outDir, `${name}.hbfm.txt`), text.endsWith('\n') ? text : `${text}\n`);
}

/** Sample body for style snippets (they change the CSS, so they need something to act on). */
const STYLE_SAMPLE = [
  '# Chapter Title',
  'Drop caps, indents and colours come from the theme. This paragraph follows the heading, so it',
  'gets the drop cap; the next paragraph is indented.',
  '',
  'A second paragraph with **bold**, *italic* and a [link](#p1).',
  '',
  '{{note',
  '##### A Note',
  'Notes use the theme\'s note frame.',
  '}}',
  '',
  '| d6 | Result |',
  '|:--:|:-------|',
  '| 1  | Nothing happens |',
  '| 2  | Something happens |',
  '',
  '{{pageNumber,auto}}',
  '{{footnote PART 1 | FIXTURE}}',
].join('\n');

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

interface SnippetNode {
  name: string;
  gen?: unknown;
  subsnippets?: SnippetNode[];
  experimental?: boolean;
  disabled?: boolean;
}
interface SnippetGroup {
  groupName: string;
  view: 'text' | 'style';
  snippets: SnippetNode[];
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  for (const file of readdirSync(outDir)) {
    // case-*.hbfm.txt are hand-written (kept; listed with kind 'case').
    if (file.endsWith('.hbfm.txt') && !file.startsWith('case-')) rmSync(path.join(outDir, file));
  }

  const server = await createServer({
    configFile: false,
    root: webDir,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [webDir, themesDir, path.join(repoRoot, 'tests')] } },
    plugins: [captureHbfm],
    resolve: {
      alias: { '@themes': themesDir, '@': path.join(webDir, 'src') },
      dedupe: ['lodash', 'dedent', 'marked', '@codemirror/view', '@codemirror/state'],
    },
    optimizeDeps: { noDiscovery: true, include: [] },
  });

  try {
    // 1. welcome_msg.md. Its absolute homebrewery.naturalcrit.com asset URLs are made
    //    site-relative so they load from the dev server like the theme's own assets.
    const welcome = readFileSync(path.join(repoRoot, 'legacy/client/homebrew/pages/homePage/welcome_msg.md'), 'utf8')
      .replaceAll('\r\n', '\n')
      .replaceAll('https://homebrewery.naturalcrit.com/assets/', '/assets/');
    writeFixture(
      { base: 'welcome', kind: 'welcome', source: 'legacy/client/homebrew/pages/homePage/welcome_msg.md', theme: '5ePHB', note: 'asset URLs made site-relative' },
      welcome,
    );

    // 2. Theme snippets.
    const themes = ['Blank', '5ePHB', '5eDMG', 'Journal'];
    const skipped: string[] = [];
    for (const theme of themes) {
      const file = path.join(themesDir, 'V3', theme, 'snippets.js');
      const mod = (await server.ssrLoadModule(file)) as { default?: SnippetGroup[] };
      for (const group of mod.default ?? []) {
        const walk = (snippets: SnippetNode[], trail: string[]) => {
          for (const snippet of snippets) {
            const names = [...trail, snippet.name];
            if (snippet.subsnippets?.length) walk(snippet.subsnippets, names);
            if (snippet.gen === undefined || snippet.gen === '' || snippet.disabled) continue;
            const key = `${theme}/${group.groupName}/${names.join('/')}`;
            reseed(key);
            let output: string;
            try {
              const context = {
                brew: { title: 'Fidelity Fixture', shareId: 'fixture', renderer: 'V3', theme: '5ePHB', lang: 'en', text: welcome },
                view: group.view,
              };
              const gen = snippet.gen;
              output = typeof gen === 'function' ? String((gen as (c: unknown) => unknown)(context)) : typeof gen === 'string' ? gen : JSON.stringify(gen);
            } catch (error) {
              skipped.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
              continue;
            }
            if (!output.trim()) {
              skipped.push(`${key}: empty output`);
              continue;
            }
            const base = `snippet-${slug(theme, 8)}-${slug(group.groupName, 16)}-${slug(names.join(' '), 40)}`;
            const text = group.view === 'style' ? `\`\`\`css\n${output}\n\`\`\`\n\n${STYLE_SAMPLE}` : output;
            writeFixture(
              {
                base,
                kind: 'snippet',
                source: `themes/V3/${theme}/snippets.js › ${group.groupName} › ${names.join(' › ')}`,
                theme: '5ePHB',
                ...(group.view === 'style' ? { note: 'style snippet: the CSS block plus a sample body' } : {}),
              },
              text,
            );
          }
        };
        walk(group.snippets, []);
      }
    }

    // 3. tests/markdown cases.
    const testsDir = path.join(repoRoot, 'tests', 'markdown');
    for (const file of readdirSync(testsDir).filter((f) => f.endsWith('.test.js')).sort()) {
      currentFile = file;
      const before = cases.length;
      await server.ssrLoadModule(path.join(testsDir, file));
      const fileSlug = slug(file.replace(/\.test\.js$/, ''), 20);
      cases.slice(before).forEach((c, i) => {
        const base = `md-${fileSlug}-${String(i + 1).padStart(3, '0')}-${slug(c.title.split(' › ').pop() ?? '', 36)}`;
        writeFixture({ base, kind: 'markdown-test', source: `tests/markdown/${file} › ${c.title}`, theme: '5ePHB' }, c.pages.join('\n\\page\n'));
      });
    }

    // 4. Hand-written cases (web/e2e/fixtures/case-*.hbfm.txt): the first line is an HTML comment saying what it tests.
    const casesDir = path.join(webDir, 'e2e', 'fixtures');
    for (const file of readdirSync(casesDir).filter((f) => f.startsWith('case-') && f.endsWith('.hbfm.txt')).sort()) {
      const text = readFileSync(path.join(casesDir, file), 'utf8');
      const name = file.replace(/\.hbfm\.txt$/, '');
      const note = /^<!--\s*([\s\S]*?)\s*-->/.exec(text)?.[1]?.replace(/\s+/g, ' ');
      used.add(name);
      fixtures.push({ name, kind: 'case', source: `web/e2e/fixtures/${file} (hand-written)`, theme: '5ePHB', ...(note ? { note } : {}) });
      if (casesDir !== outDir) writeFileSync(path.join(outDir, file), text);
    }

    writeFileSync(path.join(outDir, 'fixtures.json'), `${JSON.stringify({ generated: 'npx tsx scripts/fidelity-fixtures.ts', skipped, fixtures }, null, 2)}\n`);
    console.log(`${fixtures.length} fixtures written to ${path.relative(webDir, outDir)}`);
    if (skipped.length) console.log(`skipped:\n  ${skipped.join('\n  ')}`);
  } finally {
    await server.close();
  }
}

await main();
