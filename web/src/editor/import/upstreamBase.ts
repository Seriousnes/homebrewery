// The base styles upstream's preview iframe had under every theme, scoped to .hb-canvas:
// legacy/shared/naturalcrit/styles/reset.less, core.less (`html, body { font-family: 'Open Sans' }`,
// `* { box-sizing: border-box }`) and the page rules of legacy/.../brewRenderer/brewRenderer.less.
// Zero specificity (:where), as upstream, so every theme rule wins.
//
// Used by the import probe (canvas/probe.ts) and the S3 legacy-render harness, which lay out
// upstream's HTML without the editor's canvas.css. canvas.css reproduces the same base for the
// editor (its "Upstream base styles" section).
import openSans400 from '../canvas/fonts/open-sans-latin-400-normal.woff2?url';
import openSans700 from '../canvas/fonts/open-sans-latin-700-normal.woff2?url';

const OPEN_SANS_RANGE =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

/**
 * Open Sans, upstream's base font (legacy/shared/naturalcrit/styles/fonts/fonts.css), for
 * documents that don't get EditorCanvas.module.css's @font-face rules: the probe iframe and the
 * S3 harness frames. Same files (web/src/editor/canvas/fonts) and ranges as the editor.
 */
export const OPEN_SANS_CSS = [
  [openSans400, 'normal'],
  [openSans700, 'bold'],
]
  .map(
    ([url, weight]) =>
      `@font-face { font-family: 'Open Sans'; font-style: normal; font-weight: ${weight}; src: url('${url}') format('woff2'); font-display: swap; unicode-range: ${OPEN_SANS_RANGE}; }`,
  )
  .join('\n');

export const UPSTREAM_BASE_CSS = String.raw`
:where(.hb-canvas) {
  margin: 0;
  padding: 0;
  border: 0;
  font: 400 16px/1 'Open Sans', sans-serif;
  vertical-align: baseline;
}
:where(.hb-canvas, .hb-canvas *) {
  box-sizing: border-box;
}
:where(.hb-canvas)
  :where(
    div, span, applet, object, iframe, h1, h2, h3, h4, h5, h6, p, blockquote, pre, a, abbr, acronym,
    address, big, cite, code, del, dfn, em, img, ins, kbd, q, s, samp, small, strike, strong, sub,
    sup, tt, var, b, u, i, center, dl, dt, dd, ol, ul, li, fieldset, form, button, label, legend,
    table, caption, tbody, tfoot, thead, tr, th, td, article, aside, canvas, details, embed, figure,
    figcaption, footer, header, hgroup, menu, nav, output, ruby, section, summary, time, mark, audio,
    video
  ) {
  padding: 0;
  margin: 0;
  font: inherit;
  font-size: 100%;
  vertical-align: baseline;
  border: 0;
}
:where(.hb-canvas) :where(article, aside, details, figcaption, figure, footer, header, hgroup, menu, nav, section) {
  display: block;
}
:where(.hb-canvas) :where(ol, ul) {
  list-style: none;
}
:where(.hb-canvas) :where(blockquote, q) {
  quotes: none;
}
:where(.hb-canvas) :where(table) {
  border-spacing: 0;
  border-collapse: collapse;
}
:where(.hb-canvas) :where(button) {
  color: unset;
  text-transform: unset;
  background-color: unset;
}
:where(.hb-canvas) :where(i) {
  text-box-trim: trim-both;
}
@supports (break-after: always) {
  .hb-canvas .pages .columnSplit {
    margin-bottom: 100vh;
  }
}
`;

/**
 * Probe-only rules: every page is laid out (the theme's content-visibility: auto would skip
 * pages off screen) and the flow fills the page's content box column by column, so content
 * that doesn't fit shows up as extra columns (plan §4.2) and clipped pages can be detected.
 */
export const PROBE_LAYOUT_CSS = String.raw`
.hb-canvas .page {
  content-visibility: visible !important;
}
.hb-canvas .page > .columnWrapper {
  height: 100%;
  max-height: 100%;
  column-fill: auto;
}
`;
