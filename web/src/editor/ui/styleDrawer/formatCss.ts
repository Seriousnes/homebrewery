// Prettier formatting for the Style drawer (P3.6), ported from legacy formatCSS
// (legacy/client/components/codeEditor/extensions/customKeyMaps.js:9-56). prettier/standalone and
// its postcss plugin are loaded on first use only (about 400 kB), in their own chunk.
import type * as Prettier from 'prettier/standalone';
import type * as PostcssPlugin from 'prettier/plugins/postcss';

/** Legacy's options. */
export const PRETTIER_CSS_OPTIONS = {
  parser: 'css',
  tabWidth: 2,
  useTabs: false,
  printWidth: 100,
  singleQuote: false,
  trailingComma: 'all',
  bracketSpacing: true,
  endOfLine: 'lf',
} as const;

type PrettierModules = [typeof Prettier, typeof PostcssPlugin];
let loading: Promise<PrettierModules> | null = null;

/** Starts (or joins) loading Prettier. Call early (e.g. on hover of the Format button) to hide the delay. */
export function loadPrettier(): Promise<PrettierModules> {
  loading ??= Promise.all([import('prettier/standalone'), import('prettier/plugins/postcss')]).catch((error: unknown) => {
    loading = null; // allow a retry (e.g. a chunk that failed to load offline)
    throw error;
  });
  return loading;
}

/**
 * Rules with a single declaration on one line, as legacy did after Prettier (which can't do it):
 * ".a {\n  color: red;\n}" → ".a { color: red; }".
 */
export function collapseSingleDeclarationRules(css: string): string {
  return css.replace(/([^{}\n][^{}]*)\{\s*\n\s*([^;\n{}]+:[^;\n{}]+;)\s*\n\s*\}(\s*)/g, (_, selector: string, declaration: string, space: string) => {
    return `${selector.trimEnd()} { ${declaration.trim()} }${space}`;
  });
}

/** A CSS syntax error Prettier reported, with its position when it has one (1-based). */
export class CssFormatError extends Error {
  readonly line: number | null;
  readonly column: number | null;
  constructor(message: string, line: number | null, column: number | null) {
    super(message);
    this.name = 'CssFormatError';
    this.line = line;
    this.column = column;
  }
}

function toFormatError(error: unknown): CssFormatError {
  const e = error as { message?: unknown; reason?: unknown; loc?: { start?: { line?: unknown; column?: unknown } } };
  const line = typeof e?.loc?.start?.line === 'number' ? e.loc.start.line : null;
  const column = typeof e?.loc?.start?.column === 'number' ? e.loc.start.column : null;
  const raw = typeof e?.reason === 'string' ? e.reason : typeof e?.message === 'string' ? e.message.split('\n')[0]! : String(error);
  // Prettier appends " (3:1)"; the position is reported separately.
  const reason = raw.replace(/\s*\(\d+:\d+\)\s*$/, '').trim() || 'The CSS could not be read';
  return new CssFormatError(reason, line, column);
}

/** Formats CSS like the legacy editor. Throws CssFormatError for CSS Prettier can't parse. */
export async function formatCss(code: string): Promise<string> {
  const [prettier, postcss] = await loadPrettier();
  let formatted: string;
  try {
    formatted = await prettier.format(code, { ...PRETTIER_CSS_OPTIONS, plugins: [postcss] });
  } catch (error) {
    throw toFormatError(error);
  }
  return collapseSingleDeclarationRules(formatted);
}

/** The smallest single replacement that turns `before` into `after` (common prefix and suffix kept). */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--;
    endAfter--;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}
