// Sanitizer for imported HBFM output (plan §7): DOMPurify with an allow-list derived from what
// the schema can hold, replacing upstream's blacklist (legacy/.../brewRenderer/safeHTML.js).
//
// Kept:  the HTML the schema has nodes/marks for, the tags its rawHtml catch-all keeps
//        (RAW_HTML_TAGS minus embeds), inline tags the parser treats as transparent (their
//        text survives), SVG (markdeep diagrams), and the attributes the schema stores:
//        class, style, id, title, lang, dir, role, data-*, aria-*, plus per-tag attributes
//        (src, href, alt, align, colspan, …).
// Removed: script, style (lifted into the brew CSS before sanitizing, see hbfmToDoc), iframe,
//        object, embed, forms and their controls, link/meta/base, template, comments, every
//        on* handler, javascript:/vbscript: URLs, and data: URLs outside img/video/audio.
//
// A private DOMPurify instance is used, so hooks and settings never leak into the schema's
// rawHtml sanitizer (schema/html.ts) or other callers of the default instance.
import createDOMPurify, { type Config, type DOMPurify as DOMPurifyInstance } from 'dompurify';

// (DOMPurify's default export is callable: createDOMPurify(window) returns a new instance.)

/** HTML tags kept by the import sanitizer (SVG comes from DOMPurify's svg profiles). */
export const IMPORT_HTML_TAGS = [
  // flow the schema models
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote',
  'pre', 'code', 'hr', 'br', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
  'caption',
  // inline the schema models
  'span', 'a', 'img', 'i', 'em', 'b', 'strong', 'u', 's', 'del', 'strike', 'sub', 'sup',
  // inline tags without a rule (transparent: text kept, tag dropped by the parser)
  'font', 'small', 'big', 'mark', 'ins', 'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'time', 'dfn',
  'tt', 'bdi', 'bdo', 'wbr', 'ruby', 'rt', 'rp', 'label', 'nobr',
  // kept whole as rawHtml (RAW_HTML_TAGS without iframe/object)
  'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption',
  'details', 'summary', 'fieldset', 'legend', 'center', 'address', 'hgroup', 'video', 'audio',
  'source', 'track', 'picture', 'canvas', 'map', 'area',
] as const;

/** Attributes kept (in addition to data-* and aria-*, which DOMPurify allows by default). */
export const IMPORT_HTML_ATTRS = [
  // generic attributes (plan §3.5)
  'class', 'style', 'id', 'title', 'lang', 'dir', 'role',
  // per tag
  'href', 'name', 'src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'align', 'valign',
  'colspan', 'rowspan', 'span', 'headers', 'scope', 'start', 'reversed', 'type', 'value', 'cite',
  'datetime', 'open', 'controls', 'loop', 'muted', 'poster', 'preload', 'usemap', 'shape', 'coords',
  'face', 'color', 'size', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'nowrap',
] as const;

const CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: [...IMPORT_HTML_TAGS],
  ADD_ATTR: [...IMPORT_HTML_ATTRS],
  // The svg profiles bring their own <style> (and <a>, fine): no stylesheets inside the flow.
  FORBID_TAGS: ['style', 'script', 'foreignobject', 'use'],
  FORBID_ATTR: ['contenteditable', 'autofocus', 'tabindex', 'formaction', 'srcdoc', 'xlink:href'],
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  // No <body>-less parsing quirks: sanitize the page content as a body fragment.
  FORCE_BODY: true,
};

/** What the sanitizer removed from one call, by tag and by attribute name. */
export interface SanitizeRemovals {
  elements: Record<string, number>;
  attributes: Record<string, number>;
}

export interface SanitizeResult {
  html: string;
  removed: SanitizeRemovals;
}

let purifier: DOMPurifyInstance | null = null;

function instance(): DOMPurifyInstance | null {
  if (purifier) return purifier;
  if (typeof window === 'undefined') return null;
  purifier = createDOMPurify(window);
  return purifier.isSupported ? purifier : null;
}

const bump = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] ?? 0) + 1;
};

/**
 * Sanitizes one page of rendered HBFM and reports what was removed. Throws where DOMPurify
 * can't run (no DOM), so an import can never skip sanitizing.
 */
export function sanitizeImportHtmlDetailed(html: string): SanitizeResult {
  const purify = instance();
  if (!purify) throw new Error('sanitizeImportHtml needs a DOM (DOMPurify is not supported here).');
  // DOMPurify turns '' into '<!-->' and reports removing that comment: nothing to do instead.
  if (html === '') return { html: '', removed: { elements: {}, attributes: {} } };
  const out = purify.sanitize(html, CONFIG);
  return { html: out, removed: realRemovals(purify.removed) };
}

/**
 * DOMPurify.removed minus its own scaffolding, which isn't content: FORCE_BODY prepends a
 * `<remove></remove>` element and removes it first, the `<body>` it parses into is reported too
 * (a `<body>` tag inside a fragment never becomes an element: the HTML parser drops it), and
 * whitespace-only text between removed elements carries nothing.
 */
export function realRemovals(items: DOMPurifyInstance['removed']): SanitizeRemovals {
  const removed: SanitizeRemovals = { elements: {}, attributes: {} };
  let scaffoldSeen = false;
  items.forEach((item, i) => {
    if ('attribute' in item) {
      if (!item.attribute) return;
      // DOM-clobbering protection drops ids like "title" (document.title). On headings that loses
      // nothing: the HeadingIds plugin gives every heading its slug id again.
      if (item.attribute.name === 'id' && /^H[1-6]$/.test(item.from?.nodeName ?? '')) return;
      bump(removed.attributes, item.attribute.name);
      return;
    }
    const el = item.element;
    const name = el.nodeName.toLowerCase();
    if (name === 'body') return;
    if (name === 'remove' && !scaffoldSeen && i === 0 && el.childNodes.length === 0) {
      scaffoldSeen = true;
      return;
    }
    if (name === '#text' && (el.textContent ?? '').trim() === '') return;
    bump(removed.elements, name);
  });
  return removed;
}

/** Sanitizes one page of rendered HBFM (see the module header for what is kept). */
export function sanitizeImportHtml(html: string): string {
  return sanitizeImportHtmlDetailed(html).html;
}
