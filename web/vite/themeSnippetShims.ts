// Theme snippet shims and the production-bundle guard (plan §6.3, snippets lane P5.1).
//
// 1. themes/V3/Blank/snippets.js statically imports two generator modules that can't run in
//    this editor: snippets/footer.gen.js imports marked-hbfm (a dev dependency) and calls an
//    undefined global, and snippets/tableOfContents.gen.js reads upstream's preview iframe.
//    themes/ is shared with upstream and stays unchanged, so both imports are redirected to the
//    editor's native replacements in web/src/editor/snippets/shims (dev, test and build).
// 2. In `vite build`, the bundle must not contain marked-hbfm, marked-variables or expr-eval:
//    brew text is untrusted, and marked-variables evaluates it with expr-eval (the P0 security
//    finding). Snippets and imports render with web/src/editor/import/hbfm/renderer.ts. A chunk
//    that holds code from one of these packages fails the build (a warning only when the dev
//    routes are built in with VITE_HB_DEV_ROUTES=1: /dev/legacy-render uses marked-hbfm).
import path from 'node:path';
import { normalizePath, type Plugin, type ResolvedConfig } from 'vite';

/** Generator modules under themes/ (relative to it) → shim files (relative to the shims dir). */
export const THEME_SNIPPET_SHIMS: Readonly<Record<string, string>> = {
  'V3/Blank/snippets/footer.gen.js': 'footer.gen.ts',
  'V3/Blank/snippets/tableOfContents.gen.js': 'tableOfContents.gen.ts',
};

/** Packages whose code must never reach the production bundle. */
export const FORBIDDEN_BUNDLE_PACKAGES = ['marked-hbfm', 'marked-variables', 'expr-eval'] as const;

export interface ThemeSnippetShimsOptions {
  /** The repository's themes/ directory. */
  themesDir: string;
  /** Directory holding the shim modules (web/src/editor/snippets/shims). */
  shimsDir: string;
  /** Override for tests; default: FORBIDDEN_BUNDLE_PACKAGES. */
  forbidden?: readonly string[];
}

const stripQuery = (id: string): string => id.replace(/[?#].*$/, '');
const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The shim for an import of `source` from `importer`, or null. Only relative imports from files
 * under `themesDir` are redirected.
 */
export function resolveThemeSnippetShim(source: string, importer: string | undefined, options: ThemeSnippetShimsOptions): string | null {
  if (!importer || !source.startsWith('.')) return null;
  // Cheap test first: this runs for every relative import of the app.
  const from = normalizePath(stripQuery(importer));
  if (!/[\\/]themes[\\/]V3[\\/]/i.test(from)) return null;
  const themesDir = normalizePath(path.resolve(options.themesDir));
  const fromAbs = normalizePath(path.resolve(from));
  if (!samePath(fromAbs.slice(0, themesDir.length + 1), `${themesDir}/`)) return null;
  const target = normalizePath(path.resolve(path.dirname(fromAbs), stripQuery(source)));
  for (const [themed, shim] of Object.entries(THEME_SNIPPET_SHIMS)) {
    if (samePath(target, `${themesDir}/${themed}`)) return normalizePath(path.resolve(options.shimsDir, shim));
  }
  return null;
}

/** `node_modules/<package>/` in a module id (any nesting, either slash). */
function packagePattern(names: readonly string[]): RegExp {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return new RegExp(`[\\\\/]node_modules[\\\\/](?:${escaped.join('|')})[\\\\/]`);
}

/** Minimal shape of Rollup's output bundle that the guard reads. */
export interface BundleLike {
  [fileName: string]:
    | { type: 'chunk'; modules: Record<string, { renderedLength: number }> }
    | { type: 'asset' };
}

/** Module ids from forbidden packages that contribute code to the bundle, as "chunk: id". */
export function forbiddenBundleModules(bundle: BundleLike, forbidden: readonly string[] = FORBIDDEN_BUNDLE_PACKAGES): string[] {
  const pattern = packagePattern(forbidden);
  const found: string[] = [];
  for (const [fileName, output] of Object.entries(bundle)) {
    if (output.type !== 'chunk') continue;
    for (const [id, info] of Object.entries(output.modules)) {
      if (info.renderedLength > 0 && pattern.test(normalizePath(stripQuery(id)))) found.push(`${fileName}: ${id}`);
    }
  }
  return found;
}

/**
 * The shim resolver (every mode) and the bundle guard (build only). Add to `plugins` in
 * vite.config.ts: `...themeSnippetShims({ themesDir, shimsDir })`.
 */
export function themeSnippetShims(options: ThemeSnippetShimsOptions): Plugin[] {
  let config: ResolvedConfig | null = null;
  return [
    {
      name: 'hb-theme-snippet-shims',
      enforce: 'pre',
      resolveId(source, importer) {
        return resolveThemeSnippetShim(source, importer, options);
      },
    },
    {
      name: 'hb-bundle-guard',
      apply: 'build',
      configResolved(resolved) {
        config = resolved;
      },
      generateBundle(_outputOptions, bundle) {
        const found = forbiddenBundleModules(bundle, options.forbidden);
        if (found.length === 0) return;
        const message =
          `The bundle contains code from ${(options.forbidden ?? FORBIDDEN_BUNDLE_PACKAGES).join(', ')}, ` +
          `which production code must never import (render HBFM with src/editor/import/hbfm/renderer.ts):\n  ${found.join('\n  ')}`;
        if (config?.env.VITE_HB_DEV_ROUTES === '1') this.warn(`${message}\n(allowed: VITE_HB_DEV_ROUTES=1 builds the dev pages in)`);
        else this.error(message);
      },
    },
  ];
}
