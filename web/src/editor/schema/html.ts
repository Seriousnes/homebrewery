// HTML helpers shared by the schema's parse rules and renderHTML.
//
// This module must load under Node (the schema manifest script imports the schema), so it
// never touches `document` or `window` at import time. DOMPurify is safe to import there: without
// a window it reports `isSupported === false`, and sanitizeRawHtml then fails closed.
import DOMPurify, { type Config } from 'dompurify';

// ---------------------------------------------------------------------------------------------
// --HB_src (image source exposed to CSS, used by .wrapLeft / .wrapRight shape-outside)
// ---------------------------------------------------------------------------------------------

/** marked-hbfm writes `--HB_src:url(<src>);` in front of any injected image styles. */
const HB_SRC_DECLARATION =
  /(^|;)\s*--HB_src\s*:\s*url\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*)\s*\)\s*(?:;|$)/i;

/** The `--HB_src` declaration for `src`, byte-identical to marked-hbfm for ordinary URLs. */
export function hbSrcDeclaration(src: string): string {
  // Plain URLs are written unquoted, as upstream does. Anything that would end the url() token
  // early (spaces, quotes, parentheses, backslashes) is quoted and escaped instead.
  const value = /^[^\s()"'\\]*$/.test(src) ? src : `"${src.replace(/["\\\n\r]/g, (c) => `\\${c}`)}"`;
  return `--HB_src:url(${value});`;
}

/** Removes the generated `--HB_src` declaration from an image's style attribute. */
export function stripHbSrc(style: string | null): string | null {
  if (style === null) return null;
  const stripped = style.replace(HB_SRC_DECLARATION, '$1').replace(/^\s*;?\s*/, '').trim();
  return stripped === '' ? null : stripped;
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

const UNSAFE_URL = /^\s*(?:javascript|vbscript|data)\s*:/i;
// eslint-disable-next-line no-control-regex -- strips the control characters browsers ignore in schemes
const IGNORED_URL_CHARS = /[\u0000-\u001F\u007F\s]+/g;

/**
 * False for javascript:, vbscript: and data: URLs (after removing characters browsers ignore).
 * @deprecated A deny-list, looser than the server: use isSafeHref (links) or isSafeSrc (images).
 */
export function isSafeUrl(url: string): boolean {
  return !UNSAFE_URL.test(url.replace(IGNORED_URL_CHARS, ''));
}

// The allow-lists below mirror the server's UrlPolicy (src/Homebrewery.Core/Documents/UrlPolicy.cs,
// plan §8.5 rule 4), so the editor never shows a URL that saving would drop.

/** Longest URL accepted (UrlPolicy.MaxLength). */
export const MAX_URL_LENGTH = 2 * 1024 * 1024;

/**
 * Whether the UTF-16 code unit `c` is one IGNORED_URL_CHARS removes: C0 controls, space, DEL and
 * the rest of JavaScript's \s (UrlPolicy.IsIgnored on the server).
 */
function isIgnoredUrlChar(c: number): boolean {
  return (
    c <= 0x20 ||
    c === 0x7f ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** ASCII-only lower case (a JavaScript /i regex without the u flag: 'İ' is not 'i'). */
function asciiLower(c: number): number {
  return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
}

/**
 * The lower-case scheme of `url` (`[A-Za-z][A-Za-z0-9+.-]*` before the first ':'), or null when
 * relative. Characters browsers ignore are skipped wherever they are and however many there are,
 * and the scheme may be any length, as in the server's UrlPolicy.SchemeOf: nothing is cut before
 * they are skipped (review SEC-2), and only the scheme is scanned, not the whole URL.
 */
export function urlScheme(url: string): string | null {
  let scheme = '';
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (isIgnoredUrlChar(c)) continue;
    const lower = asciiLower(c);
    const letter = lower >= 0x61 && lower <= 0x7a;
    if (scheme === '') {
      if (!letter) return null;
    } else if (c === 0x3a /* : */) {
      return scheme;
    } else if (!(letter || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e)) {
      return null; // not [a-z0-9+.-]: a relative URL
    }
    scheme += String.fromCharCode(lower);
  }
  return null;
}

/** Whether the significant characters of `url` start with 'data:image/' (any ASCII case). */
function isDataImage(url: string): boolean {
  const prefix = 'data:image/';
  let matched = 0;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (isIgnoredUrlChar(c)) continue;
    if (asciiLower(c) !== prefix.charCodeAt(matched)) return false;
    if (++matched === prefix.length) return true;
  }
  return false;
}

/** Link targets: http, https, mailto, relative URLs (also //host, ?query) and #anchors. */
export function isSafeHref(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;
  const scheme = urlScheme(url);
  return scheme === null || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

/** Image and page-object sources: http, https, relative URLs and data:image/*. */
export function isSafeSrc(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;
  const scheme = urlScheme(url);
  if (scheme === 'data') return isDataImage(url);
  return scheme === null || scheme === 'http' || scheme === 'https';
}

// ---------------------------------------------------------------------------------------------
// Raw HTML (rawHtml node)
// ---------------------------------------------------------------------------------------------

/**
 * DOMPurify settings for rawHtml. Defaults (HTML + SVG + MathML, no scripts, no event
 * handlers, no javascript: URLs) plus: no <style>/<link>/<meta>/<base> (brew CSS lives in the
 * Style drawer and would otherwise escape the .hb-canvas scope), no contenteditable, and what the
 * server's RawHtmlSanitizer removes too: forms and form controls, SVG use/foreignObject/animation,
 * tabindex and formaction, and URLs other than http, https, mailto and relative ones (DOMPurify
 * still lets data: through in img/media src; the server keeps data:image/* in img src only).
 */
const RAW_HTML_CONFIG: Config = {
  FORBID_TAGS: [
    'style',
    'link',
    'meta',
    'base',
    'title',
    'form',
    'input',
    'button',
    'select',
    'textarea',
    'option',
    'optgroup',
    'datalist',
    'keygen',
    'output',
    'use',
    'foreignobject',
    'animate',
    'animatemotion',
    'animatetransform',
    'set',
  ],
  FORBID_ATTR: ['contenteditable', 'autofocus', 'tabindex', 'formaction'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  ALLOW_DATA_ATTR: true,
};

/** Sanitized HTML for a rawHtml node. Returns '' where DOMPurify can't run (Node without DOM). */
export function sanitizeRawHtml(html: string): string {
  if (!DOMPurify.isSupported) return '';
  return DOMPurify.sanitize(html, RAW_HTML_CONFIG).trim();
}

/** Marks a wrapper element added around rawHtml that is not a single element. */
export const RAW_HTML_WRAPPER_ATTR = 'data-hb-raw';

export interface RawHtmlDomOptions {
  /** Element that wraps HTML which isn't one element kept as is: div (rawHtml), span (rawInline). */
  wrapper?: 'div' | 'span';
  /** Whether a single root element may be emitted as is (default: any element). */
  keepRoot?: (el: Element) => boolean;
}

/**
 * The DOM for a rawHtml (or rawInline) node's `html`. A single root element is returned as is
 * (so theme selectors see the same structure as upstream); anything else is wrapped in
 * `div[data-hb-raw]` (`span[data-hb-raw]` inline), which the parse rules unwrap again.
 */
export function rawHtmlToElement(html: string, doc: Document, options: RawHtmlDomOptions = {}): HTMLElement {
  const template = doc.createElement('template');
  template.innerHTML = sanitizeRawHtml(html);
  const nodes = Array.from(template.content.childNodes).filter(
    (n) => !(n.nodeType === 3 && (n.textContent ?? '').trim() === ''),
  );
  const only = nodes.length === 1 ? nodes[0] : undefined;
  if (only && only.nodeType === 1 && (options.keepRoot?.(only as Element) ?? true)) return doc.importNode(only, true) as HTMLElement;
  const wrapper = doc.createElement(options.wrapper ?? 'div');
  wrapper.setAttribute(RAW_HTML_WRAPPER_ATTR, '');
  wrapper.append(doc.importNode(template.content, true));
  return wrapper;
}

// ---------------------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------------------

/** Parses a JSON attribute value, or returns undefined when it is missing or invalid. */
export function parseJsonAttribute(el: HTMLElement, name: string): unknown {
  const raw = el.getAttribute(name);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** A CSS class token: no whitespace, not empty. */
export const isClassToken = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && !/\s/.test(value);
