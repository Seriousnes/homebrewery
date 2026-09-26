// Runtime scoping of CSS text (the brew's own CSS and user-theme CSS) to the editing canvas
// (plan §5). Static themes get the same rewrite at build time (web/vite/scopeThemes.ts, whose
// scopeSelector() is copied below: that module is Node-only and must not enter the bundle).
//
//   const sheet = scopeCss(userCss, document.baseURI);   // CSSStyleSheet
//   document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
//
// themeLoader.applyThemeStyles takes `scopeCss` as its hook and attaches the sheets after the
// theme chain. The CSSOM does the parsing, so whatever the browser accepts is scoped and
// whatever it drops never reaches the page:
//
// - Top-level style rules and style rules inside @media, @supports, @layer, @container and
//   @starting-style get every selector of their list prefixed with `.hb-canvas`; `:root`, `html`
//   and `body` (as the leading compound) become `.hb-canvas` itself. A selector that then reaches
//   a sibling of the canvas (`:root ~ x`, `body + x`) gets the subject constraint below.
// - Nested style rules (CSS nesting) stay relative to their parent, but a nested selector that
//   holds `&` anywhere (`:not(&)`, `:has(&)`) gets no implicit `& ` prefix and could match
//   outside the canvas. So every nested selector (also inside @media/@supports/… in a style
//   rule) gets the subject constraint `:where(.hb-canvas, .hb-canvas *)` on its last compound,
//   before any pseudo-element; nested @scope roots get it too. A rule whose rewritten selector
//   the browser rejects is dropped (never left unscoped).
// - @scope (start) gets its start selectors scoped; @scope without a start is dropped.
// - @font-face, @keyframes, @page, @property, @counter-style and @font-feature-values are
//   untouched (they don't select elements).
// - Table header rows (P5.6): selectors for <thead> and <tbody> rows are rewritten so they also
//   match the editor's leading header rows, tr.hb-header-row (tables/headerRowSelectors.ts; the
//   build-time scoping does the same).
// - @import is ignored by constructed stylesheets. inlineCssImports() (async) fetches imported
//   sheets and inlines them first; EditorCanvas does that before scoping.

import { rewriteHeaderRowSelectorList } from '../tables/headerRowSelectors';

export const CANVAS_SCOPE = '.hb-canvas';

const ROOT_NAME = String.raw`(?::root|html|body)`;
const ROOT_END = String.raw`(?=$|[\s.:#[>+~])`;
const LEADING_ROOTS = new RegExp(String.raw`^${ROOT_NAME}(?:\s*>?\s*${ROOT_NAME})*${ROOT_END}`, 'i');

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Scopes one selector (no top-level commas). Same rules as web/vite/scopeThemes.ts. */
export function scopeSelector(selector: string, scope: string = CANVAS_SCOPE): string {
  const trimmed = selector.trim();
  if (trimmed === '') return trimmed;
  if (new RegExp(`^${escapeRegExp(scope)}${ROOT_END}`).test(trimmed)) return trimmed;
  const root = LEADING_ROOTS.exec(trimmed);
  if (root) return scope + trimmed.slice(root[0].length);
  return `${scope} ${trimmed}`;
}

/**
 * Splits a selector list at its top-level commas: commas inside (), [] and strings (`:is(a, b)`,
 * `[title="a,b"]`) don't split.
 */
export function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((s) => s.trim()).filter((s) => s !== '');
}

/** Scopes every selector of a selector list. */
export function scopeSelectorList(list: string, scope: string = CANVAS_SCOPE): string {
  return splitSelectorList(list)
    .map((s) => scopeSelector(s, scope))
    .join(', ');
}

/** `:where(scope, scope *)`: matches the canvas and everything inside it, adds no specificity. */
const insideScope = (scope: string): string => `:where(${scope}, ${scope} *)`;

const LEGACY_PSEUDO_ELEMENT = /^:(?:before|after|first-line|first-letter)(?![\w-])/i;

/**
 * Walks the top level of a selector (outside (), [] and strings) and calls `visit` with each
 * character's index. Returning true stops the walk.
 */
function walkTopLevel(selector: string, visit: (i: number, ch: string) => boolean | void): void {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && visit(i, ch)) return;
  }
}

/**
 * Adds the subject constraint to one selector: `:where(scope, scope *)` on its last compound,
 * in front of a pseudo-element (`&::before` → `&:where(…)::before`), so the selector only matches
 * the canvas and its descendants.
 */
export function constrainSelector(selector: string, scope: string = CANVAS_SCOPE): string {
  const trimmed = selector.trim();
  let insert = -1;
  walkTopLevel(trimmed, (i, ch) => {
    if (/[\s>+~]/.test(ch)) insert = -1; // a new compound starts
    else if (ch === ':' && insert === -1 && (trimmed[i + 1] === ':' || LEGACY_PSEUDO_ELEMENT.test(trimmed.slice(i)))) insert = i;
  });
  const at = insert === -1 ? trimmed.length : insert;
  return `${trimmed.slice(0, at)}${insideScope(scope)}${trimmed.slice(at)}`;
}

/** constrainSelector for every selector of a list. */
export function constrainSelectorList(list: string, scope: string = CANVAS_SCOPE): string {
  return splitSelectorList(list)
    .map((s) => constrainSelector(s, scope))
    .join(', ');
}

/** The combinator after the first compound of a selector (' ' for descendant), or null. */
function firstCombinator(selector: string): string | null {
  let end = -1;
  walkTopLevel(selector, (i, ch) => {
    if (!/[\s>+~]/.test(ch)) return false;
    end = i;
    return true;
  });
  if (end === -1) return null;
  const next = /^\s*([>+~])?/.exec(selector.slice(end))!;
  return next[1] ?? ' ';
}

/**
 * Scopes a top-level selector list (scopeSelectorList), constraining the selectors that would
 * reach siblings of the canvas: `:root ~ x` becomes `.hb-canvas ~ x`, which the constraint makes
 * match nothing.
 */
function scopeTopLevelList(list: string, scope: string): string {
  // Table header rows (P5.6): `thead …` also matches tr.hb-header-row, tbody rows skip it.
  return splitSelectorList(rewriteHeaderRowSelectorList(list))
    .map((s) => {
      const scoped = scopeSelector(s, scope);
      const combinator = firstCombinator(scoped);
      return combinator === '+' || combinator === '~' ? constrainSelector(scoped, scope) : scoped;
    })
    .join(', ');
}

const squashSelector = (text: string): string => text.replace(/\s+/g, '');

/** Whether the browser kept `wanted` for every selector of the list (it ignores invalid ones). */
function selectorsKept(actual: string, wanted: (part: string) => boolean): boolean {
  const parts = splitSelectorList(actual);
  return parts.length > 0 && parts.every(wanted);
}

// CSSOM rule kinds, detected without instanceof (jsdom and cross-realm sheets).
const STYLE_RULE = 1;
const hasRules = (rule: CSSRule): rule is CSSGroupingRule => 'cssRules' in rule && 'insertRule' in rule;
const ruleName = (rule: CSSRule): string => rule.constructor?.name ?? '';

/** At-rules whose contents are not element-selecting style rules. */
const OPAQUE_RULES = new Set(['CSSKeyframesRule', 'CSSFontFeatureValuesRule', 'CSSPageRule', 'CSSFontFaceRule']);

export interface ScopeReport {
  /** Style rules whose selectors were rewritten. */
  scopedRules: number;
  /** Rules removed because they can't be scoped (e.g. `@scope { … }` without a start). */
  droppedRules: string[];
}

type RuleParent = CSSStyleSheet | CSSGroupingRule;

/**
 * Re-creates an @scope rule with its start selectors scoped (top level) or constrained (nested
 * in a style rule). A top-level @scope without a start is dropped; a nested one keeps the parent
 * rule's (constrained) element as its root and stays.
 */
function scopeScopeRule(parent: RuleParent, index: number, rule: CSSRule, scope: string, report: ScopeReport, nested = false): void {
  const r = rule as CSSRule & { start?: string | null; end?: string | null; cssRules: CSSRuleList };
  if (nested) constrainNested(r as unknown as CSSGroupingRule, scope, report);
  if (nested && !r.start) return;
  parent.deleteRule(index);
  if (!r.start) {
    report.droppedRules.push(rule.cssText.slice(0, 80));
    return;
  }
  const inner = Array.from(r.cssRules)
    .map((x) => x.cssText)
    .join('\n');
  const start = nested ? constrainSelectorList(r.start, scope) : scopeTopLevelList(r.start, scope);
  const prelude = `(${start})${r.end ? ` to (${r.end})` : ''}`;
  try {
    parent.insertRule(`@scope ${prelude} {\n${inner}\n}`, index);
    report.scopedRules++;
  } catch {
    report.droppedRules.push(rule.cssText.slice(0, 80));
  }
}

/** Sets a style rule's selector; drops the rule when the browser keeps a selector that fails `kept`. */
function setSelector(parent: RuleParent, index: number, style: CSSStyleRule, next: string, kept: (part: string) => boolean, report: ScopeReport): boolean {
  const before = style.cssText.slice(0, 80);
  style.selectorText = next;
  if (selectorsKept(style.selectorText, kept)) {
    report.scopedRules++;
    return true;
  }
  parent.deleteRule(index); // the browser rejected the rewrite: never leave it unscoped
  report.droppedRules.push(before);
  return false;
}

/**
 * Nested rules (CSS nesting) of a scoped style rule: every style rule's selectors get the subject
 * constraint, at any depth and inside nested @media, @supports, @container, @layer, @scope ….
 */
function constrainNested(parent: CSSStyleRule | CSSGroupingRule, scope: string, report: ScopeReport): void {
  const rules = (parent as { cssRules?: CSSRuleList }).cssRules;
  if (!rules) return;
  const marker = squashSelector(insideScope(scope));
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (rule.type === STYLE_RULE) {
      const style = rule as CSSStyleRule;
      const next = constrainSelectorList(rewriteHeaderRowSelectorList(style.selectorText), scope);
      if (setSelector(parent, i, style, next, (part) => squashSelector(part).includes(marker), report)) {
        constrainNested(style, scope, report);
      }
    } else if (ruleName(rule) === 'CSSScopeRule') {
      scopeScopeRule(parent, i, rule, scope, report, true);
    } else if (hasRules(rule) && !OPAQUE_RULES.has(ruleName(rule))) {
      constrainNested(rule, scope, report);
    }
  }
}

function rewrite(parent: RuleParent, scope: string, report: ScopeReport): void {
  const prefix = squashSelector(scope);
  // Backwards, so @scope replacement (delete + insert) keeps the indexes valid.
  for (let i = parent.cssRules.length - 1; i >= 0; i--) {
    const rule = parent.cssRules[i]!;
    if (rule.type === STYLE_RULE) {
      const style = rule as CSSStyleRule;
      const next = scopeTopLevelList(style.selectorText, scope);
      if (setSelector(parent, i, style, next, (part) => squashSelector(part).startsWith(prefix), report)) {
        constrainNested(style, scope, report); // CSS nesting (see the file header)
      }
    } else if (ruleName(rule) === 'CSSScopeRule') {
      scopeScopeRule(parent, i, rule, scope, report);
    } else if (hasRules(rule) && !OPAQUE_RULES.has(ruleName(rule))) {
      rewrite(rule, scope, report); // @media, @supports, @layer, @container, @starting-style
    }
  }
}

export interface ScopeCssOptions {
  scope?: string;
  /** Receives what was scoped and dropped. */
  report?: (report: ScopeReport) => void;
}

/**
 * Parses `css` into a constructed stylesheet whose every rule only applies inside the canvas.
 * `baseURL` resolves relative url()s (the source of the CSS). Signature matches
 * themeLoader's ScopeCss hook.
 */
export function scopeCss(css: string, baseURL: string, scopeOrOptions: string | ScopeCssOptions = CANVAS_SCOPE): CSSStyleSheet {
  const options = typeof scopeOrOptions === 'string' ? { scope: scopeOrOptions } : scopeOrOptions;
  const scope = options.scope ?? CANVAS_SCOPE;
  const sheet = new CSSStyleSheet({ baseURL });
  sheet.replaceSync(stripCssImports(css));
  const report: ScopeReport = { scopedRules: 0, droppedRules: [] };
  rewrite(sheet, scope, report);
  options.report?.(report);
  return sheet;
}

/** Scoped CSS as text (tests, export previews). */
export function scopeCssText(css: string, baseURL = 'http://localhost/', scope = CANVAS_SCOPE): string {
  return Array.from(scopeCss(css, baseURL, scope).cssRules)
    .map((r) => r.cssText)
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// @import
// ---------------------------------------------------------------------------------------------

export interface CssImport {
  url: string;
  /** Everything after the URL: layer(…), supports(…) and media queries. */
  conditions: string;
  /** The whole statement as written. */
  statement: string;
}

// @import url(x) …; | @import "x" …;  (comments before them are allowed)
const IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')([^;]*);/gi;
const LEADING_TRIVIA = /^(?:\s+|\/\*[\s\S]*?\*\/|@charset\s+"[^"]*"\s*;|@layer\s+[\w\s,.-]+;)*/;

/** The leading @import statements of `css` (imports anywhere else are invalid CSS anyway). */
export function extractCssImports(css: string): CssImport[] {
  const imports: CssImport[] = [];
  let rest = css;
  for (;;) {
    rest = rest.slice(LEADING_TRIVIA.exec(rest)?.[0].length ?? 0);
    IMPORT.lastIndex = 0;
    const m = IMPORT.exec(rest);
    if (!m || m.index !== 0) break;
    imports.push({ url: (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim(), conditions: (m[6] ?? '').trim(), statement: m[0] });
    rest = rest.slice(m[0].length);
  }
  return imports;
}

/** `css` without its @import statements (constructed sheets reject them with a warning). */
export function stripCssImports(css: string): string {
  let out = css;
  for (const imp of extractCssImports(css)) out = out.replace(imp.statement, '');
  return out;
}

/** Wraps imported CSS in the import's conditions: layer(x) → @layer x, supports() and media. */
function wrapImported(css: string, conditions: string): string {
  let rest = conditions;
  let out = css;
  const supports = /supports\(((?:[^()]|\([^()]*\))*)\)/i.exec(rest);
  const layer = /layer(?:\(\s*([\w.-]+)\s*\))?/i.exec(rest);
  if (supports) rest = rest.replace(supports[0], '');
  if (layer) rest = rest.replace(layer[0], '');
  const media = rest.trim();
  if (media) out = `@media ${media} {\n${out}\n}`;
  if (supports) out = `@supports (${supports[1]}) {\n${out}\n}`;
  if (layer) out = `@layer${layer[1] ? ` ${layer[1]}` : ''} {\n${out}\n}`;
  return out;
}

/** Makes the url()s of imported CSS absolute (it is inlined into a sheet with another base). */
export function absolutizeCssUrls(css: string, baseUrl: string): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, quote: string, url: string) => {
    if (/^(?:data:|#|[a-z][a-z\d+.-]*:)/i.test(url)) return whole;
    try {
      return `url(${quote}${new URL(url, baseUrl).href}${quote})`;
    } catch {
      return whole;
    }
  });
}

export interface InlineImportsOptions {
  baseUrl: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Imports of imports, up to this depth (default 3). */
  maxDepth?: number;
  /** Fetched CSS by absolute URL; pass the same map to avoid refetching while CSS is edited. */
  cache?: Map<string, Promise<string | null>>;
  /**
   * Stops waiting (the call resolves at once, its result is meant to be dropped). Fetches already
   * started keep going, up to timeoutMs, and stay in `cache` for the next call.
   */
  signal?: AbortSignal;
  /** An import that hasn't answered after this long is cancelled and counts as failed (default 10 s). */
  timeoutMs?: number;
}

/** Default of InlineImportsOptions.timeoutMs. */
export const IMPORT_TIMEOUT_MS = 10_000;

/** One imported sheet's text, or null on HTTP and network errors and after `timeoutMs`. */
function fetchImportedCss(fetchFn: NonNullable<InlineImportsOptions['fetch']>, url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const fetched = fetchFn(url, { signal: controller.signal, credentials: 'omit', mode: 'cors' })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  return Promise.race([fetched, timeout]).finally(() => clearTimeout(timer));
}

/** `promise`, or null as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

export interface InlinedCss {
  css: string;
  /** Imports that could not be fetched (CORS, network, HTTP errors): skipped. */
  failed: string[];
}

/**
 * Replaces the leading @import statements of `css` by the imported CSS (fetched, with relative
 * url()s made absolute, wrapped in their media/supports/layer conditions), so a constructed
 * sheet gets them. Typical use: Google Fonts imports in a brew's style. Imports that fail or time
 * out (timeoutMs) are dropped and listed in `failed`: they are never attached unscoped.
 */
export async function inlineCssImports(css: string, options: InlineImportsOptions, depth = 0): Promise<InlinedCss> {
  const imports = extractCssImports(css);
  if (imports.length === 0) return { css, failed: [] };
  const fetchFn = options.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const cache = options.cache ?? new Map<string, Promise<string | null>>();
  const failed: string[] = [];
  const parts: string[] = [];
  for (const imp of imports) {
    let url: string;
    try {
      url = new URL(imp.url, options.baseUrl).href;
    } catch {
      failed.push(imp.url);
      continue;
    }
    if (depth >= (options.maxDepth ?? 3)) {
      failed.push(url);
      continue;
    }
    let pending = cache.get(url);
    if (!pending) {
      const fetching = fetchImportedCss(fetchFn, url, options.timeoutMs ?? IMPORT_TIMEOUT_MS);
      // Failures are retried on the next call (also when this one was aborted meanwhile).
      void fetching.then((text) => {
        if (text === null && cache.get(url) === fetching) cache.delete(url);
      });
      cache.set(url, fetching);
      pending = fetching;
    }
    const text = await unlessAborted(pending, options.signal);
    if (options.signal?.aborted) return { css: stripCssImports(css), failed };
    if (text === null) {
      failed.push(url);
      continue;
    }
    const nested = await inlineCssImports(text, { ...options, baseUrl: url, cache }, depth + 1);
    failed.push(...nested.failed);
    parts.push(wrapImported(absolutizeCssUrls(stripCssImports(nested.css), url), imp.conditions));
  }
  return { css: `${parts.join('\n')}\n${stripCssImports(css)}`, failed };
}
