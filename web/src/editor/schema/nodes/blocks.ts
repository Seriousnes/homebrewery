// Homebrewery block nodes: theme blocks ({{monster,frame …}}), column breaks (\column),
// spacers (: lines), the live table of contents and raw HTML.
import { Node } from '@tiptap/core';
import { RAW_HTML_WRAPPER_ATTR, rawHtmlToElement, sanitizeRawHtml } from '../html';

/**
 * themeBlock: div.block.<classes> with block content ({{note …}}, {{monster,frame …}},
 * {{wide …}}). The `block` class is dropped on parse (RESERVED_CLASSES) and re-added here; the
 * other classes, style, id and attributes are the generic attributes.
 */
export const ThemeBlock = Node.create({
  name: 'themeBlock',
  group: 'block',
  content: 'block+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div.block', priority: 60 }];
  },

  renderHTML({ HTMLAttributes }) {
    const { class: authorClass, ...rest } = HTMLAttributes as Record<string, unknown>;
    const cls = typeof authorClass === 'string' && authorClass !== '' ? `block ${authorClass}` : 'block';
    return ['div', { class: cls, ...rest }, 0];
  },
});

/** columnBreak: div.columnSplit (\column). The theme gives it break-after: column. */
export const ColumnBreak = Node.create({
  name: 'columnBreak',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div.columnSplit', priority: 60 }];
  },

  renderHTML() {
    return ['div', { class: 'columnSplit' }];
  },
});

/** spacer: div.blank, one per ':' of a `:` / `::` line (1em of vertical space in the theme). */
export const Spacer = Node.create({
  name: 'spacer',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'div.blank', priority: 60 }];
  },

  renderHTML() {
    return ['div', { class: 'blank' }];
  },
});

export interface TocAttrs {
  /**
   * deepest heading level listed (1–6); the theme's --TOC: exclude still applies. HTML without
   * data-depth parses as 6 (upstream had no limit); JSON without it gets the default 3.
   */
  depth: number;
  /** .wide: spans both columns (the upstream generator always adds it) */
  wide: boolean;
  /** text of the TOC's own h1 */
  title: string;
}

/**
 * toc: the live table of contents (plan §6.5), an atom. The entries are computed by the TOC
 * NodeView (P5.4) from the document's headings and page numbers; the static HTML here is the
 * frame the theme's dot-leader rules expect: div.block.toc[.wide] › h1 + ul.
 */
export const Toc = Node.create({
  name: 'toc',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      depth: {
        default: 3,
        validate: 'number',
        // Without a valid data-depth (an imported {{toc,wide …}}, pasted upstream HTML) every
        // level is listed and the theme's --TOC decides, as upstream's generator did: Blank
        // leaves h4–h6 out unless .tocDepthH4 … / .tocIncludeH4 … bring them back (review UI-8).
        parseHTML: (el) => {
          const depth = parseInt(el.getAttribute('data-depth') ?? '', 10);
          return depth >= 1 && depth <= 6 ? depth : 6;
        },
        renderHTML: (a) => ({ 'data-depth': String(a.depth) }),
      },
      wide: {
        default: true,
        validate: 'boolean',
        parseHTML: (el) => el.classList.contains('wide'),
        renderHTML: () => ({}), // a class, added below
      },
      title: {
        default: 'Contents',
        validate: 'string',
        parseHTML: (el) => el.querySelector(':scope > h1')?.textContent?.trim() ?? 'Contents',
        renderHTML: () => ({}), // the h1, added below
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.block.toc', priority: 70 }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { wide, title } = node.attrs as TocAttrs;
    return ['div', { ...HTMLAttributes, class: wide ? 'block toc wide' : 'block toc' }, ['h1', {}, title], ['ul', {}]];
  },
});

/**
 * rawHtml: anything the importer doesn't recognise (plan §7), kept as sanitized HTML and edited
 * in a code popover (RawHtmlView). `html` is normally the outerHTML of one element.
 *
 * Catch-all parse rules (lowest priority, so every specific rule wins) take these elements
 * whole, keeping their sanitized outerHTML:
 *
 *   div          only with at least one attribute left after sanitizing (a bare <div> stays
 *                transparent, so pasted wrappers don't swallow content) and not one of the
 *                schema's own divs (.page, .columnWrapper, .block, .columnSplit, .blank)
 *   RAW_HTML_TAGS below (sectioning and embedded content with no schema node); inside text,
 *                the embedded ones are rawInline instead (nodes/inline.ts)
 *
 * Rendering emits a single root element as is only when these rules take it back; other HTML
 * goes in div[data-hb-raw], so JSON → HTML → JSON keeps the node.
 *
 * Everything else without a rule is transparent: its children are parsed, its own tag and
 * attributes are dropped (e.g. a plain <span style>, <font>, <small>, <mark>). The importer's
 * report should count those. Elements DOMPurify removes entirely (iframe, form controls, …)
 * are skipped.
 */
export const RAW_HTML_TAGS = [
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'figure',
  'details',
  'fieldset',
  'center',
  'address',
  'hgroup',
  'svg',
  'math',
  'video',
  'audio',
  'picture',
  'canvas',
  'object',
  'iframe',
  'map',
] as const;

const SCHEMA_DIV_CLASSES = ['page', 'columnWrapper', 'block', 'columnSplit', 'blank'];
/** Clipboard metadata: never a reason to keep a div, never stored. */
const IGNORED_DIV_ATTRS = new Set(['data-pm-slice', 'data-hb-clipboard']);

/** Whether the div catch-all takes this element: not a schema div, and an attribute that counts. */
function isCatchAllDiv(el: Element): boolean {
  if (el.localName !== 'div' || SCHEMA_DIV_CLASSES.some((c) => el.classList.contains(c))) return false;
  return Array.from(el.attributes).some((a) => !IGNORED_DIV_ATTRS.has(a.name) && a.name !== RAW_HTML_WRAPPER_ATTR);
}

/** Whether a single root element renders as is: it parses back as this rawHtml by itself. */
const parsesAsRawHtml = (el: Element): boolean => (RAW_HTML_TAGS as readonly string[]).includes(el.localName) || isCatchAllDiv(el);

/** The sanitized outerHTML, without clipboard metadata. */
function catchRawHtml(el: HTMLElement): { html: string } | false {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const name of IGNORED_DIV_ATTRS) clone.removeAttribute(name);
  const html = sanitizeRawHtml(clone.outerHTML);
  return html === '' ? false : { html };
}

/**
 * The div catch-all: decided on the sanitized element, so a div whose only attributes are the
 * ones sanitizing removes (onclick, unknown names) stays transparent instead of locking its
 * content in an atom.
 */
function catchRawDiv(el: HTMLElement): { html: string } | false {
  if (!isCatchAllDiv(el)) return false;
  const caught = catchRawHtml(el);
  if (!caught) return false;
  const template = el.ownerDocument.createElement('template');
  template.innerHTML = caught.html;
  const root = template.content.firstElementChild;
  return root && template.content.childNodes.length === 1 && !isCatchAllDiv(root) ? false : caught;
}

export const RawHtml = Node.create({
  name: 'rawHtml',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      html: {
        default: '',
        validate: 'string',
        // Set by the parse rules' getAttrs.
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      // Our own wrapper for multi-root HTML: unwrap it again.
      {
        tag: `div[${RAW_HTML_WRAPPER_ATTR}]`,
        priority: 5,
        getAttrs: (el) => {
          const html = sanitizeRawHtml(el.innerHTML);
          return html === '' ? false : { html };
        },
      },
      { tag: 'div', priority: 1, getAttrs: (el) => catchRawDiv(el) },
      ...RAW_HTML_TAGS.map((tag) => ({
        tag,
        priority: 1,
        getAttrs: (node: HTMLElement) => catchRawHtml(node),
      })),
    ];
  },

  renderHTML({ node }) {
    const html = typeof node.attrs.html === 'string' ? node.attrs.html : '';
    if (typeof document === 'undefined') return ['div', { [RAW_HTML_WRAPPER_ATTR]: '' }];
    // A single root another rule would claim (<p>, a bare <div>, a span …) goes in the wrapper,
    // so the HTML parses back to this node.
    return rawHtmlToElement(html, document, { keepRoot: parsesAsRawHtml });
  },
});
