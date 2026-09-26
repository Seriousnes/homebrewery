// Homebrewery's {{class,key:value,#id,attr=x}} tags and {…} injection become four generic
// attributes on every node that can carry them (plan §3.5): classes, style, id and attributes.
import { Extension, type Attribute } from '@tiptap/core';
import { isClassToken, stripHbSrc } from './html';

/**
 * Classes the editor adds itself. They are re-added by renderHTML, so parse rules drop them
 * from `classes` (otherwise a round trip would duplicate them).
 */
export const RESERVED_CLASSES: ReadonlySet<string> = new Set([
  'block',
  'inline-block',
  'page',
  'columnWrapper',
  'ProseMirror',
  'hb-continued',
  'hb-cols-1',
  'hb-cols-2',
  'hb-oversized',
  'hb-dl-multiline',
]);
/** Editor state classes (ProseMirror-selectednode, tiptap, …) never belong to a document. */
const EDITOR_STATE_CLASS = /^(?:ProseMirror|tiptap)(?:-|$)/;

/** HTML attributes an author may set through `attributes` (plan §3.5). */
export const SAFE_ATTR = /^(data-[\w-]+|aria-[\w-]+|title|lang|dir|role)$/;

/**
 * Attribute names the schema itself renders (page data, heading flags, clipboard markers).
 * They match SAFE_ATTR but must not be captured into the generic `attributes` map.
 */
export const RESERVED_ATTRS: ReadonlySet<string> = new Set([
  'data-pid',
  'data-kind',
  'data-markers',
  'data-objects',
  'data-footer',
  'data-page-number',
  'data-custom-id',
  'data-depth',
  'data-hb-raw',
  'data-pm-slice', // ProseMirror clipboard metadata
  'data-hb-clipboard', // marks this editor's clipboard HTML (canvas/pasteCleanup.ts)
]);

/** Node types that carry the generic attributes. */
export const HB_ATTR_TYPES = [
  'page',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'image',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'definitionList',
  'themeBlock',
  'inlineBox',
] as const;
export type HbAttrType = (typeof HB_ATTR_TYPES)[number];

/** Per-type DOM attributes that are real node attributes and so stay out of `attributes`. */
const OWN_DOM_ATTRS: Partial<Record<string, readonly string[]>> = {
  image: ['title'],
};

export interface HbGenericAttrs {
  classes: string[];
  style: string | null;
  id: string | null;
  attributes: Record<string, string>;
}

/** Whether a class token may be an author's: not in RESERVED_CLASSES, not an editor state class. */
export const isAuthorClass = (c: string): boolean => !RESERVED_CLASSES.has(c) && !EDITOR_STATE_CLASS.test(c);

/** Author classes of an element: everything except RESERVED_CLASSES and editor state classes. */
export function parseClasses(el: HTMLElement): string[] {
  return Array.from(el.classList).filter(isAuthorClass);
}

/** `classes` as stored, cleaned for rendering (tolerates malformed JSON values). */
export function cleanClasses(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isClassToken) : [];
}

/** Whether `name` may be stored in the generic `attributes` map of a `type` node. */
export function isAllowedAttribute(name: string, type?: string): boolean {
  if (!SAFE_ATTR.test(name) || RESERVED_ATTRS.has(name)) return false;
  return !(type && OWN_DOM_ATTRS[type]?.includes(name));
}

/** The safe DOM attributes of an element, for the generic `attributes` map. */
export function parseSafeAttributes(el: HTMLElement, type?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (isAllowedAttribute(attr.name, type)) out[attr.name] = attr.value;
  }
  return out;
}

/** `attributes` as stored, cleaned for rendering: only safe names and string values survive. */
export function cleanAttributes(value: unknown, type?: string): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && isAllowedAttribute(name, type)) out[name] = v;
  }
  return out;
}

/**
 * The element's style, normalized the way the DOM serializes it (`el.style.cssText`, e.g.
 * "color:red" → "color: red;"). ProseMirror renders style attributes through style.cssText, so
 * storing the normalized form keeps JSON → HTML → JSON stable. Declarations the browser doesn't
 * understand are dropped here, as they would be when rendered. Images drop the generated
 * `--HB_src` declaration.
 */
export function parseStyle(el: HTMLElement): string | null {
  const raw = el.getAttribute('style');
  if (raw === null) return null;
  const css = typeof el.style?.cssText === 'string' ? el.style.cssText : raw;
  const style = el.tagName === 'IMG' ? stripHbSrc(css) : css.trim();
  return style ? style : null;
}

/**
 * Normalizes an author-entered style string the same way parseStyle does (for the inspector and
 * other code that writes `style`). Needs a DOM; returns the input trimmed without one.
 */
export function normalizeStyle(style: string, doc: Document | undefined = globalThis.document): string | null {
  if (!doc) return style.trim() || null;
  const probe = doc.createElement('span');
  probe.setAttribute('style', style);
  return probe.style.cssText.trim() || null;
}

/**
 * Attribute definitions for the four generic attributes. Used by HbAttributes (nodes) and by
 * the span mark, which carries the same attributes.
 */
export function genericAttributes(type?: string): Record<keyof HbGenericAttrs, Attribute> {
  return {
    classes: {
      default: [],
      parseHTML: (el) => parseClasses(el),
      renderHTML: (a) => {
        const classes = cleanClasses(a.classes);
        return classes.length ? { class: classes.join(' ') } : {};
      },
    },
    style: {
      default: null,
      validate: 'string|null',
      parseHTML: (el) => parseStyle(el),
      renderHTML: (a) => (typeof a.style === 'string' && a.style !== '' ? { style: a.style } : {}),
    },
    id: {
      default: null,
      validate: 'string|null',
      keepOnSplit: false, // ids stay on the first fragment / the original block
      parseHTML: (el) => el.getAttribute('id') || null,
      renderHTML: (a) => (typeof a.id === 'string' && a.id !== '' ? { id: a.id } : {}),
    },
    attributes: {
      default: {},
      parseHTML: (el) => parseSafeAttributes(el, type),
      renderHTML: (a) => cleanAttributes(a.attributes, type),
    },
  };
}

export const HbAttributes = Extension.create({
  name: 'hbAttributes',
  addGlobalAttributes() {
    // One entry per type so per-type exclusions (OWN_DOM_ATTRS) apply.
    return HB_ATTR_TYPES.map((type) => ({ types: [type], attributes: genericAttributes(type) }));
  },
});

// ---------------------------------------------------------------------------------------------
// Other shared attribute definitions
// ---------------------------------------------------------------------------------------------

/**
 * `continuation: true` marks the second fragment of a block that pagination split (plan §3.4).
 * It renders as the class `hb-continued` (text-indent: 0 in canvas.css).
 */
export const continuationAttribute: Attribute = {
  default: false,
  validate: 'boolean',
  keepOnSplit: false,
  parseHTML: (el) => el.classList.contains('hb-continued'),
  renderHTML: (a) => (a.continuation === true ? { class: 'hb-continued' } : {}),
};
