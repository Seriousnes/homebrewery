// The export's layout probe (P6.4): the export document, with absolute URLs, laid out in a hidden
// sandboxed iframe (no scripts) of the app's origin. It answers what only a laid-out page knows:
//
// - which headings the theme leaves out of tables of contents (computed --TOC: exclude), as the
//   editor's toc refresher reads them (toc/tocPlugin.ts isExcludedByTheme);
// - which url()s of the stylesheets the page uses, so only those are inlined: the theme chain
//   refers to far more images (watercolor masks, cover art, borders) and fonts than one brew
//   needs. A style rule's images count when its selector (pseudo-elements and hover/focus state
//   removed) matches an element, in any @media (print too); a @font-face's files count when the
//   browser loaded, or tried to load, that face for the page (the probe first asks the
//   FontFaceSet for the faces of every piece of text, loadTextFonts). Rules the check can't judge (nested
//   CSS, selectors querySelector rejects, @page, @keyframes) count as used;
// - the size of every page (CSS px), for the file's default @page size.
import { splitSelectorList } from '../canvas/cssScope';
import { waitForFonts } from '../canvas/themeLoader';
import { tocKeyword } from '../toc';
import { cssUrls, elementSelector } from './cssText';
import { absoluteUrl } from './resources';

/** Attribute on the heading elements of the probed document: the heading's index. */
export const HEADING_INDEX_ATTR = 'data-hb-export-heading';

export interface ExportProbeResult {
  /** Indexes (the HEADING_INDEX_ATTR values) of the headings the theme excludes from TOCs. */
  excludedHeadings: Set<number>;
  /** Absolute URLs of the url()s the page's CSS uses. */
  cssUrls: Set<string>;
  /** false when fonts were still loading at the timeout (their faces then count as used). */
  fontsSettled: boolean;
  /** Border-box size of every div.page, in CSS px, in order. */
  pageSizes: { width: number; height: number }[];
}

/** Lays out an export document (HTML text, absolute URLs) and reports what it uses. */
export type ExportProbe = (html: string) => Promise<ExportProbeResult>;

export interface IframeProbeOptions {
  /** The document the iframe is added to (default: document). */
  document?: Document;
  /** How long to wait for fonts (default 10 s). */
  fontsTimeoutMs?: number;
  /** Viewport width in CSS px (default 1100). */
  width?: number;
}

const STYLE_RULE = 1;
const IMPORT_RULE = 3;
const FONT_FACE_RULE = 5;
const PAGE_RULE = 6;
const KEYFRAMES_RULE = 7;

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const normalWeight = (value: string) => {
  const v = value.trim().toLowerCase();
  return v === 'normal' || v === '' ? '400' : v === 'bold' ? '700' : v;
};
const normalRange = (value: string) => {
  const v = value.replace(/\s+/g, '').toUpperCase();
  return v === '' ? 'U+0-10FFFF' : v;
};

interface FaceDescriptors {
  family: string;
  style: string;
  weight: string;
  unicodeRange: string;
}

function looseKey(d: FaceDescriptors): string {
  return [unquote(d.family).toLowerCase(), (d.style.trim() || 'normal').toLowerCase(), normalWeight(d.weight)].join('|');
}
const exactKey = (d: FaceDescriptors) => `${looseKey(d)}|${normalRange(d.unicodeRange)}`;

/** Whether some face of the page with these descriptors was loaded (or tried to be). */
function faceUsage(fonts: Iterable<FontFace>): (d: FaceDescriptors) => boolean {
  const exact = new Map<string, boolean>();
  const loose = new Map<string, boolean>();
  for (const face of fonts) {
    const used = face.status !== 'unloaded';
    const d = { family: face.family, style: face.style, weight: face.weight, unicodeRange: face.unicodeRange };
    exact.set(exactKey(d), (exact.get(exactKey(d)) ?? false) || used);
    loose.set(looseKey(d), (loose.get(looseKey(d)) ?? false) || used);
  }
  // No face with these descriptors at all: the check can't tell, so the files count as used.
  return (d) => exact.get(exactKey(d)) ?? loose.get(looseKey(d)) ?? true;
}

/** Whether a selector list matches an element of `doc` (true when it can't be checked). */
function selectorUsed(doc: Document, selectorText: string): boolean {
  for (const part of splitSelectorList(selectorText)) {
    try {
      if (doc.querySelector(elementSelector(part))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** The url()s of the page's stylesheets that the laid-out page uses (see the file header). */
export function usedCssUrls(doc: Document): Set<string> {
  const used = new Set<string>();
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  const faceUsed = fonts ? faceUsage(fonts) : () => true;
  const add = (cssText: string) => {
    for (const url of cssUrls(cssText)) {
      const href = absoluteUrl(url, doc.baseURI);
      if (href) used.add(href);
    }
  };
  // Rule kinds by CSSRule.type (the probe's rules come from another realm: no instanceof).
  const visit = (rules: CSSRuleList, inStyleRule: boolean) => {
    for (const rule of Array.from(rules)) {
      const nested = (rule as { cssRules?: CSSRuleList }).cssRules;
      if (rule.type === STYLE_RULE) {
        const style = rule as CSSStyleRule;
        const text = style.style.cssText;
        if (text.includes('url(') && (inStyleRule || selectorUsed(doc, style.selectorText))) add(text);
        if (nested?.length) visit(nested, true);
      } else if (rule.type === FONT_FACE_RULE) {
        const decl = (rule as CSSFontFaceRule).style;
        const d = {
          family: decl.getPropertyValue('font-family'),
          style: decl.getPropertyValue('font-style'),
          weight: decl.getPropertyValue('font-weight'),
          unicodeRange: decl.getPropertyValue('unicode-range'),
        };
        if (faceUsed(d)) add(decl.getPropertyValue('src') || rule.cssText);
      } else if (rule.type === IMPORT_RULE) {
        // Imports are inlined before the probe; one that is left failed to load.
      } else if (rule.type === PAGE_RULE || rule.type === KEYFRAMES_RULE || !nested) {
        if (rule.cssText.includes('url(')) add(rule.cssText); // @page, @keyframes, nested declarations: kept
      } else {
        visit(nested, inStyleRule); // @media, @supports, @layer, @container, @scope
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // not readable (another origin): nothing of ours
    }
    visit(rules, false);
  }
  return used;
}

/** The headings (HEADING_INDEX_ATTR) whose computed --TOC is `exclude`. */
export function excludedHeadings(doc: Document): Set<number> {
  const win = doc.defaultView;
  const out = new Set<number>();
  if (!win) return out;
  for (const el of Array.from(doc.querySelectorAll(`[${HEADING_INDEX_ATTR}]`))) {
    if (tocKeyword(win.getComputedStyle(el).getPropertyValue('--TOC')) === 'exclude') out.add(Number(el.getAttribute(HEADING_INDEX_ATTR)));
  }
  return out;
}

/** The border-box size of every page of the laid-out export document (CSS px). */
export function pageSizes(doc: Document): { width: number; height: number }[] {
  return Array.from(doc.querySelectorAll('.pages > .page')).map((page) => {
    const rect = page.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
}

const DIGITS = '0123456789';
const QUOTES = '“”‘’"\'';
const MARKERS = '•◦▪–0123456789.)';

/**
 * The characters a pseudo-element's computed `content` shows: its strings, digits for counters,
 * quote marks for open/close-quote ('' for none/normal).
 */
export function contentText(content: string): string {
  if (!content || content === 'none' || content === 'normal') return '';
  let text = '';
  for (const match of content.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(counters?\()|((?:no-)?(?:open|close)-quote)/g)) {
    if (match[1] !== undefined || match[2] !== undefined) text += (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1');
    else if (match[3]) text += DIGITS;
    else if (match[4]) text += QUOTES;
  }
  return text;
}

/** A `font` shorthand for FontFaceSet.load() from a computed style. */
const fontShorthand = (style: CSSStyleDeclaration) => `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

/**
 * The font (computed `font` shorthand) and the characters of every piece of text of `doc`:
 * elements' own text and the text of their ::before, ::after, ::first-letter and ::marker.
 */
export function textFonts(doc: Document): Map<string, string> {
  const win = doc.defaultView;
  const out = new Map<string, Set<string>>();
  if (!win || !doc.body) return new Map();
  const add = (style: CSSStyleDeclaration, text: string) => {
    if (!text.trim() || !style.fontFamily) return;
    const font = fontShorthand(style);
    let chars = out.get(font);
    if (!chars) out.set(font, (chars = new Set()));
    for (const ch of text) if (chars.size < 2000) chars.add(ch);
  };
  for (const el of [doc.body, ...Array.from(doc.body.querySelectorAll('*'))]) {
    let own = '';
    for (const child of Array.from(el.childNodes)) if (child.nodeType === 3) own += child.nodeValue ?? '';
    const style = win.getComputedStyle(el);
    if (style.display === 'none') continue;
    add(style, own);
    for (const pseudo of ['::before', '::after']) {
      const ps = win.getComputedStyle(el, pseudo);
      add(ps, contentText(ps.content));
    }
    const first = (el.textContent ?? '').trim().slice(0, 2);
    if (first) add(win.getComputedStyle(el, '::first-letter'), first);
    if (style.display === 'list-item') add(win.getComputedStyle(el, '::marker'), MARKERS);
  }
  return new Map(Array.from(out, ([font, chars]) => [font, Array.from(chars).join('')]));
}

/**
 * Asks the document's FontFaceSet for the faces its text needs. The browser starts font loads
 * during layout, but not always at once (Firefox can start one a tick after the layout flush), so
 * a probe that only read the faces' status could miss a face the file then needs; loading the
 * matching faces for each text makes the status reliable.
 */
export async function loadTextFonts(doc: Document): Promise<void> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  await Promise.allSettled(Array.from(textFonts(doc), ([font, text]) => fonts.load(font, text)));
}

/** The default probe: a hidden same-origin iframe without scripts. */
export function createIframeProbe(options: IframeProbeOptions = {}): ExportProbe {
  return async (html: string) => {
    const parent = options.document ?? document;
    const width = options.width ?? 1100;
    const iframe = parent.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.title = 'Export layout probe';
    iframe.style.cssText = `position:fixed;left:-${width + 20000}px;top:0;width:${width}px;height:1200px;border:0;visibility:hidden;pointer-events:none;`;
    parent.body.appendChild(iframe);
    try {
      const doc = iframe.contentDocument;
      if (!doc) throw new Error('The export probe has no document.');
      doc.open();
      doc.write(html);
      doc.close();
      const timeoutMs = options.fontsTimeoutMs ?? 10_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const loaded = await Promise.race([
        loadTextFonts(doc).then(() => true),
        new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
      ]);
      clearTimeout(timer);
      const fontsSettled = (await waitForFonts({ document: doc, root: doc.body, timeoutMs })) && loaded;
      return { excludedHeadings: excludedHeadings(doc), cssUrls: usedCssUrls(doc), fontsSettled, pageSizes: pageSizes(doc) };
    } finally {
      iframe.remove();
    }
  };
}
