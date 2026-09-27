// The stylesheets of the HTML export (P6.4, plan §5), in the editor's cascade order:
//
//   1. theme     the theme chain's static stylesheets (style.scoped.css, root first): the files
//                the editor links at the start of <head>
//   2. editor    what the app itself puts on the canvas: Open Sans, the canvas presentation
//                (EditorCanvas.module.css: inherited-property reset, page spacing, shadows),
//                canvas.css (verbatim) and TipTap's ProseMirror rules
//   3. themeCss  user themes' CSS (API bundle 'css' styles), scoped as the editor scopes them
//   4. brew      the brew's own CSS, scoped (cssScope.ts), as the editor's adopted sheet
//
// The export keeps the editor's scoping (.hb-canvas as <body>, header-row rewrites) instead of the
// unscoped style.css, so every selector has the specificity it has in the editor and the page
// renders the same. All url()s are absolute here; exportHtml inlines the ones the page uses.
import canvasCss from '../canvas/canvas.css?raw';
import { absolutizeCssUrls, inlineCssImports, scopeCssText } from '../canvas/cssScope';
import type { ThemeChain } from '../canvas/themeLoader';
import { OPEN_SANS_CSS } from '../import/upstreamBase';
import { stripCssComments } from './cssText';
import type { FetchLike } from './resources';

/**
 * The canvas presentation of EditorCanvas.module.css for a document that is only the brew: the
 * inherited-property reset of `:where(.canvas)` (the themes were written for a document that
 * inherits nothing), the single-page spread, spacing and shadows, and the print rules. Same
 * selectors' specificity as the module's, so theme and brew rules win the same ties.
 * (exportCss.test.ts checks the reset against the module.)
 */
export const CANVAS_PRESENTATION_CSS = String.raw`
html {
  background: #2c3e50;
}
body {
  margin: 0;
}
:where(.hb-canvas) {
  color-scheme: light;
  color: #000;
  font-style: normal;
  font-variant: normal;
  font-weight: 400;
  letter-spacing: normal;
  word-spacing: normal;
  text-align: start;
  text-indent: 0;
  text-transform: none;
  text-shadow: none;
  white-space: normal;
  hyphens: manual;
  direction: ltr;
  writing-mode: horizontal-tb;
  visibility: visible;
  cursor: auto;
  list-style: disc outside none;
  tab-size: 8;
  -webkit-text-stroke: 0;
  paint-order: normal;
}
.hb-canvas > :where(.pages) {
  box-sizing: border-box;
  padding: 30px 0 1px;
}
.hb-canvas > :where(.pages) > :where(.page) {
  margin-right: auto;
  margin-bottom: 30px;
  margin-left: auto;
  box-shadow: 1px 4px 14px #000;
}
@media print {
  html {
    background: none !important;
  }
  .hb-canvas > :where(.pages) {
    display: block !important;
    padding: 0 !important;
  }
  .hb-canvas > :where(.pages) > :where(.page) {
    margin: 0 !important;
    box-shadow: none !important;
  }
}
`;

/**
 * The rules of TipTap's injected stylesheet (@tiptap/core style.ts) that reach a read-only page:
 * the root's wrapping and ligatures (canvas.css overrides both), white-space: normal for elements
 * ProseMirror made contenteditable=false (atoms, page chrome, the toc), pre-wrap in <pre>, and
 * the zero-size separator image.
 */
export const PROSEMIRROR_CSS = String.raw`
.ProseMirror {
  position: relative;
}
.ProseMirror {
  word-wrap: break-word;
  white-space: pre-wrap;
  white-space: break-spaces;
  -webkit-font-variant-ligatures: none;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0;
}
.ProseMirror [contenteditable="false"] {
  white-space: normal;
}
.ProseMirror [contenteditable="false"] [contenteditable="true"] {
  white-space: pre-wrap;
}
.ProseMirror pre {
  white-space: pre-wrap;
}
img.ProseMirror-separator {
  display: inline !important;
  border: none !important;
  margin: 0 !important;
  width: 0 !important;
  height: 0 !important;
}
`;

/** The app's own canvas CSS (group 2), url()s made absolute against `baseUrl`. */
export function editorCss(baseUrl: string): string {
  return [absolutizeCssUrls(OPEN_SANS_CSS, baseUrl), CANVAS_PRESENTATION_CSS, stripCssComments(canvasCss), PROSEMIRROR_CSS]
    .map((css) => css.trim())
    .join('\n');
}

export interface ExportCss {
  /** Group 1: one entry per static stylesheet of the chain (already scoped), absolute url()s. */
  theme: string[];
  /** Group 2. */
  editor: string;
  /** Group 3: user themes' CSS, scoped. */
  themeCss: string[];
  /** Group 4: the brew's CSS, scoped. */
  brew: string;
  /** Stylesheets and @imports that could not be loaded. */
  failed: string[];
}

export interface CollectExportCssOptions {
  /** The page's URL: resolves site-relative stylesheet hrefs and the brew CSS's url()s. */
  baseUrl: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** CSS text scoped as the editor scopes it (imports inlined, url()s absolute). */
async function scopedCssText(css: string, baseUrl: string, options: CollectExportCssOptions, failed: string[]): Promise<string> {
  if (!css.trim()) return '';
  const inlined = await inlineCssImports(css, { baseUrl, fetch: options.fetch, signal: options.signal });
  failed.push(...inlined.failed);
  try {
    return scopeCssText(absolutizeCssUrls(inlined.css, baseUrl), baseUrl);
  } catch {
    failed.push('CSS that could not be parsed');
    return '';
  }
}

/** Fetches and prepares every stylesheet of the export (see the file header). */
export async function collectExportCss(chain: Pick<ThemeChain, 'styles'>, userCss: string, options: CollectExportCssOptions): Promise<ExportCss> {
  const fetchFn = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const failed: string[] = [];
  const theme: string[] = [];
  const themeCss: string[] = [];
  for (const style of chain.styles) {
    if (style.kind === 'url') {
      let href: string;
      try {
        href = new URL(style.href, options.baseUrl).href;
      } catch {
        failed.push(style.href);
        continue;
      }
      let text: string | null;
      try {
        const response = await fetchFn(href, { signal: options.signal, credentials: 'same-origin' });
        text = response.ok ? await response.text() : null;
      } catch {
        text = null;
      }
      options.signal?.throwIfAborted();
      if (text === null) {
        failed.push(href);
        continue;
      }
      const inlined = await inlineCssImports(text, { baseUrl: href, fetch: options.fetch, signal: options.signal });
      failed.push(...inlined.failed);
      theme.push(stripCssComments(absolutizeCssUrls(inlined.css, href)).trim());
    } else {
      const scoped = await scopedCssText(style.css, style.baseUrl ?? options.baseUrl, options, failed);
      if (scoped) themeCss.push(scoped);
    }
  }
  const brew = await scopedCssText(userCss, options.baseUrl, options, failed);
  options.signal?.throwIfAborted();
  return { theme, editor: editorCss(options.baseUrl), themeCss, brew, failed };
}

/** Every stylesheet of `css` in cascade order, with the group each belongs to. */
export function exportStylesheets(css: ExportCss): { group: 'theme' | 'editor' | 'theme-css' | 'brew'; css: string }[] {
  return [
    ...css.theme.map((text) => ({ group: 'theme' as const, css: text })),
    { group: 'editor' as const, css: css.editor },
    ...css.themeCss.map((text) => ({ group: 'theme-css' as const, css: text })),
    ...(css.brew ? [{ group: 'brew' as const, css: css.brew }] : []),
  ];
}
