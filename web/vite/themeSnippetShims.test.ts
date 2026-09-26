import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_BUNDLE_PACKAGES,
  forbiddenBundleModules,
  resolveThemeSnippetShim,
  themeSnippetShims,
  type BundleLike,
} from './themeSnippetShims.ts';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themesDir = path.resolve(webDir, '../themes');
const shimsDir = path.join(webDir, 'src/editor/snippets/shims');
const options = { themesDir, shimsDir };
const slash = (p: string) => p.replaceAll('\\', '/');

describe('resolveThemeSnippetShim', () => {
  const blankSnippets = path.join(themesDir, 'V3/Blank/snippets.js');

  it('redirects the footer and table-of-contents generators imported by Blank/snippets.js', () => {
    expect(slash(resolveThemeSnippetShim('./snippets/footer.gen.js', blankSnippets, options) ?? '')).toBe(
      slash(path.join(shimsDir, 'footer.gen.ts')),
    );
    expect(slash(resolveThemeSnippetShim('./snippets/tableOfContents.gen.js', `${blankSnippets}?v=123`, options) ?? '')).toBe(
      slash(path.join(shimsDir, 'tableOfContents.gen.ts')),
    );
  });

  it('accepts Vite-style ids (forward slashes)', () => {
    expect(resolveThemeSnippetShim('./snippets/footer.gen.js', slash(blankSnippets), options)).not.toBeNull();
  });

  it('leaves every other import alone', () => {
    expect(resolveThemeSnippetShim('./snippets/license.gen.js', blankSnippets, options)).toBeNull();
    expect(resolveThemeSnippetShim('dedent', blankSnippets, options)).toBeNull();
    expect(resolveThemeSnippetShim('./snippets/footer.gen.js', undefined, options)).toBeNull();
    // Same relative path, but not from the themes directory.
    expect(resolveThemeSnippetShim('./snippets/footer.gen.js', path.join(webDir, 'src/x.ts'), options)).toBeNull();
    // A theme that isn't Blank.
    expect(resolveThemeSnippetShim('./snippets/footer.gen.js', path.join(themesDir, 'V3/5ePHB/snippets.js'), options)).toBeNull();
  });
});

describe('forbiddenBundleModules', () => {
  const chunk = (modules: Record<string, number>) => ({
    type: 'chunk' as const,
    modules: Object.fromEntries(Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }])),
  });

  it('lists modules of forbidden packages that contribute code', () => {
    const bundle: BundleLike = {
      'static/index.js': chunk({
        'D:/app/node_modules/marked-hbfm/index.js': 120,
        'D:/app/node_modules/marked/lib/marked.esm.js': 5000,
        'D:\\app\\node_modules\\expr-eval\\dist\\index.mjs': 10,
      }),
      'static/other.js': chunk({ '/app/node_modules/x/node_modules/marked-variables/lib/index.js': 3 }),
      'assets/a.css': { type: 'asset' },
    };
    expect(forbiddenBundleModules(bundle)).toEqual([
      'static/index.js: D:/app/node_modules/marked-hbfm/index.js',
      'static/index.js: D:\\app\\node_modules\\expr-eval\\dist\\index.mjs',
      'static/other.js: /app/node_modules/x/node_modules/marked-variables/lib/index.js',
    ]);
  });

  it('ignores tree-shaken modules and look-alike names', () => {
    const bundle: BundleLike = {
      'static/index.js': chunk({
        'D:/app/node_modules/marked-hbfm/index.js': 0,
        'D:/app/node_modules/marked-hbfm-extra/index.js': 50,
        'D:/app/src/marked-hbfm/index.js': 50,
      }),
    };
    expect(forbiddenBundleModules(bundle)).toEqual([]);
  });

  it('knows the packages of the P0 security finding', () => {
    expect([...FORBIDDEN_BUNDLE_PACKAGES]).toEqual(['marked-hbfm', 'marked-variables', 'expr-eval']);
  });
});

// A tiny project: a "theme" whose snippets import a footer generator that imports a forbidden
// package, built with the real Vite.
describe('in a vite build', () => {
  let root: string;
  let fakeThemes: string;
  let fakeShims: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'hb-shims-'));
    fakeThemes = path.join(root, 'themes');
    fakeShims = path.join(root, 'shims');
    mkdirSync(path.join(fakeThemes, 'V3/Blank/snippets'), { recursive: true });
    mkdirSync(fakeShims, { recursive: true });
    mkdirSync(path.join(root, 'node_modules/marked-hbfm'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules/marked-hbfm/package.json'), JSON.stringify({ name: 'marked-hbfm', version: '0.0.0', type: 'module', main: 'index.js' }));
    writeFileSync(path.join(root, 'node_modules/marked-hbfm/index.js'), "export const hbfm = { render: (s) => 'FORBIDDEN_MARKER' + s };\n");
    writeFileSync(
      path.join(fakeThemes, 'V3/Blank/snippets/footer.gen.js'),
      "import { hbfm } from 'marked-hbfm';\nexport default { createFooterFunc: () => () => hbfm.render('x') };\n",
    );
    writeFileSync(path.join(fakeThemes, 'V3/Blank/snippets/tableOfContents.gen.js'), 'export default () => document.title;\n');
    writeFileSync(
      path.join(fakeThemes, 'V3/Blank/snippets.js'),
      "import FooterGen from './snippets/footer.gen.js';\nimport Toc from './snippets/tableOfContents.gen.js';\nexport default [FooterGen.createFooterFunc(), Toc];\n",
    );
    writeFileSync(path.join(fakeShims, 'footer.gen.ts'), "export default { createFooterFunc: (): (() => string) => () => 'SHIM_FOOTER' };\n");
    writeFileSync(path.join(fakeShims, 'tableOfContents.gen.ts'), "export default (): string => 'SHIM_TOC';\n");
    writeFileSync(path.join(root, 'main.js'), "import snippets from './themes/V3/Blank/snippets.js';\nconsole.log(snippets.map((g) => g()));\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = async (plugins: ReturnType<typeof themeSnippetShims>) => {
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins,
      build: { write: false, minify: false, rollupOptions: { input: path.join(root, 'main.js') } },
    });
    const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
    return outputs.flatMap((o) => o.output).map((o) => (o.type === 'chunk' ? o.code : '')).join('\n');
  };

  it('builds with the shims and without the forbidden package', async () => {
    const code = await run(themeSnippetShims({ themesDir: fakeThemes, shimsDir: fakeShims }));
    expect(code).toContain('SHIM_FOOTER');
    expect(code).toContain('SHIM_TOC');
    expect(code).not.toContain('FORBIDDEN_MARKER');
  });

  it('fails the build when forbidden code reaches the bundle', async () => {
    // Guard only: the original footer generator (and marked-hbfm) gets bundled.
    const [, guard] = themeSnippetShims({ themesDir: fakeThemes, shimsDir: fakeShims });
    await expect(run([guard!])).rejects.toThrow(/marked-hbfm/);
  });
});
