// Build-time scoping of static theme CSS (plan §5).
//
// Every selector in a theme stylesheet is prefixed with `.hb-canvas`, so theme rules only
// match inside the editing canvas and never leak into the app chrome. `:root`, `html` and
// `body` (alone, or as the leading compound of a longer selector) are rewritten to the
// canvas itself, so theme variables and `counter-reset: page-numbers` land on `.hb-canvas`.
//
// Selectors for table header rows get the header-row rewrite (see headerRowSelectors.ts).
//
// @font-face, @page and @keyframes are left untouched; rules inside @media, @supports,
// @layer and @container are prefixed like any other rule.
//
// User CSS and user themes get the same rewrite at runtime (web/src/editor/canvas/cssScope.ts).
import postcss from 'postcss';
import prefixSelector from 'postcss-prefix-selector';
// Header rows (P5.6): theme rules for <thead> / <tbody> rows also style the editor's leading
// header rows (tr.hb-header-row), which ProseMirror keeps in the table's one <tbody>. Pure string
// code shared with the runtime scoping (canvas/cssScope.ts).
import { rewriteHeaderRowSelectorList } from '../src/editor/tables/headerRowSelectors.ts';

export const CANVAS_SCOPE = '.hb-canvas';

const ROOT_NAME = String.raw`(?::root|html|body)`;
// What may follow a root compound: end of selector, whitespace, or the start of a
// qualifier/combinator (.class :pseudo #id [attr] > + ~).
const ROOT_END = String.raw`(?=$|[\s.:#[>+~])`;
// One or more leading root compounds joined by descendant/child combinators, e.g.
// `html`, `:root`, `html body`, `html > body`.
const LEADING_ROOTS = new RegExp(String.raw`^${ROOT_NAME}(?:\s*>?\s*${ROOT_NAME})*${ROOT_END}`, 'i');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Scopes one selector from a selector list (no top-level commas). */
export function scopeSelector(selector: string, scope: string = CANVAS_SCOPE): string {
  const trimmed = selector.trim();
  if (trimmed === '') return trimmed;

  // Already scoped (idempotent), e.g. `.hb-canvas .page` or `.hb-canvas.dark`.
  if (new RegExp(`^${escapeRegExp(scope)}${ROOT_END}`).test(trimmed)) return trimmed;

  const root = LEADING_ROOTS.exec(trimmed);
  if (root) return scope + trimmed.slice(root[0].length);

  return `${scope} ${trimmed}`;
}

export interface ScopeCssOptions {
  /** Selector every rule is scoped to. Defaults to `.hb-canvas`. */
  scope?: string;
  /** Source file name, used in postcss error messages. */
  from?: string;
}

/**
 * Header rows: rewrites each rule's whole selector list (thead rules get a header-row alternative;
 * a list that already names the header-row class is left alone, so scoping stays idempotent).
 * Rules inside @keyframes are steps, not selectors.
 */
const headerRows: postcss.Plugin = {
  postcssPlugin: 'hb-table-header-rows',
  Rule(rule) {
    const parent = rule.parent;
    if (parent?.type === 'atrule' && /keyframes$/i.test((parent as postcss.AtRule).name)) return;
    const next = rewriteHeaderRowSelectorList(rule.selector);
    if (next !== rule.selector) rule.selector = next;
  },
};

/** Returns `css` with every style rule scoped to the canvas (see file header). */
export function scopeCss(css: string, options: ScopeCssOptions = {}): string {
  const scope = options.scope ?? CANVAS_SCOPE;
  const plugin = prefixSelector({
    prefix: scope,
    // postcss-prefix-selector already splits selector lists correctly (it respects
    // parentheses, so `:is(a, b)` stays intact) and skips rules inside @keyframes.
    transform: (_prefix, selector) => scopeSelector(selector, scope),
  });
  return postcss([plugin, headerRows]).process(css, { from: options.from, map: false }).css;
}
