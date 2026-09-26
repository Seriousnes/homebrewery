// Document and page nodes (plan §3.6).
//
// doc › page+ › blocks. Each page renders as one fixed-size div.page, so theme CSS applies
// unchanged:
//
//   div.page[.hb-cols-1|.hb-cols-2][data-kind][data-pid]…
//     span.inline-block.<marker>        one per marker (frontCover, skipCounting, …)
//     img / span.inline-block           page objects (absolutely positioned)
//     span.inline-block.footnote        footer text (section setting)
//     span.inline-block.pageNumber.auto page number (section setting)
//     div.columnWrapper                 the flow: the page's content
//
// The page's attributes are also written as data-* attributes so HTML → JSON is lossless
// (clipboard, export, round-trip tests). The editor renders the same shape through PageView.
//
// Page ids: the DOM id of every page is `p{n}` (1-based index) in the editor, like upstream.
// renderHTML can't know the index, so the pageIndexIds plugin (schema/plugins) sets it with a
// node decoration. That works with or without a PageView NodeView: ProseMirror applies outer
// decoration attributes to NodeView.dom too (PageView.update must return true for them).
// Static export must add the ids itself. The generic `id` attribute is kept but, as upstream
// (which ignored `\page {#id}`), it is overridden by `p{n}` in the editor.
import { Node } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import { cleanClasses, isAuthorClass } from '../attrs';
import { isClassToken, isSafeSrc, parseJsonAttribute } from '../html';

export const HbDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: 'page+',
});

export const HbText = Node.create({
  name: 'text',
  group: 'inline',
});

/** manual starts a section (Mod-Enter, cover page, imported \page); auto is made by pagination. */
export type PageKind = 'manual' | 'auto';

/** Page markers: empty span.inline-block.<marker> elements that theme :has() rules look for. */
export const PAGE_MARKERS = [
  'frontCover',
  'insideCover',
  'partCover',
  'backCover',
  'skipCounting',
  'resetCounting',
] as const;
export type PageMarker = (typeof PAGE_MARKERS)[number];

/** Absolutely positioned content of one page; never part of the text flow (plan §4.9). */
export interface PageObject {
  id: string;
  kind: 'image' | 'text';
  /** e.g. banner, logo, artist, watercolor4 */
  classes: string[];
  /** includes position:absolute and offsets */
  style: string;
  src?: string;
  text?: string;
}

/**
 * Section settings: copied from a manual page to the auto pages that follow it (kept in sync by
 * an appendTransaction in commands/sections.ts).
 */
export const SECTION_ATTRS = ['columns', 'pageNumber', 'footer', 'classes', 'style'] as const;

export interface PageAttrs {
  pid: string | null;
  kind: PageKind;
  /** null = let the theme decide */
  columns: 1 | 2 | null;
  /** never inherited by auto pages */
  markers: string[];
  pageNumber: boolean;
  footer: string | null;
  objects: PageObject[];
  /** set by pagination (one block taller than a column); not rendered, not meaningful when saved */
  oversized: boolean;
  classes: string[];
  style: string | null;
  id: string | null;
  attributes: Record<string, string>;
}

/**
 * Markers as stored, cleaned: class-like strings only, no duplicates, no reserved classes (a
 * marker `columnWrapper` would render chrome that lookups take for the flow).
 */
export function normalizeMarkers(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isClassToken).filter(isAuthorClass))] : [];
}

/**
 * Page objects as stored, cleaned: malformed entries are dropped, unsafe image URLs and reserved
 * classes removed.
 */
export function normalizePageObjects(value: unknown): PageObject[] {
  if (!Array.isArray(value)) return [];
  const objects: PageObject[] = [];
  for (const raw of value as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || (o.kind !== 'image' && o.kind !== 'text')) continue;
    const object: PageObject = {
      id: o.id,
      kind: o.kind,
      classes: cleanClasses(o.classes).filter(isAuthorClass),
      style: typeof o.style === 'string' ? o.style : '',
    };
    if (typeof o.src === 'string' && isSafeSrc(o.src)) object.src = o.src;
    if (typeof o.text === 'string') object.text = o.text;
    if (object.kind === 'image' && object.src === undefined) continue;
    objects.push(object);
  }
  return objects;
}

function columnsFromClass(el: HTMLElement): 1 | 2 | null {
  if (el.classList.contains('hb-cols-1')) return 1;
  if (el.classList.contains('hb-cols-2')) return 2;
  return null;
}

/** The page chrome renderHTML emits before div.columnWrapper (PageView must emit the same). */
export function pageChromeSpec(attrs: Pick<PageAttrs, 'markers' | 'objects' | 'footer' | 'pageNumber'>): DOMOutputSpec[] {
  const chrome: DOMOutputSpec[] = [];
  for (const marker of normalizeMarkers(attrs.markers)) chrome.push(['span', { class: `inline-block ${marker}` }]);
  for (const o of normalizePageObjects(attrs.objects)) {
    chrome.push(
      o.kind === 'image'
        ? ['img', { class: o.classes.join(' ') || null, style: o.style || null, src: o.src ?? null, alt: '' }]
        : ['span', { class: ['inline-block', ...o.classes].join(' '), style: o.style || null }, o.text ?? ''],
    );
  }
  if (typeof attrs.footer === 'string') chrome.push(['span', { class: 'inline-block footnote' }, attrs.footer]);
  if (attrs.pageNumber === true) chrome.push(['span', { class: 'inline-block pageNumber auto' }]);
  return chrome;
}

/** The page's class list: page, the column class, then the author's classes. */
export function pageClass(columns: unknown, authorClass?: unknown): string {
  return [
    'page',
    columns === 1 ? 'hb-cols-1' : columns === 2 ? 'hb-cols-2' : null,
    typeof authorClass === 'string' && authorClass !== '' ? authorClass : null,
  ]
    .filter(Boolean)
    .join(' ');
}

export const Page = Node.create({
  name: 'page',
  content: 'block+',
  isolating: true, // default Backspace/Delete never cross a page; commands/continuation.ts does it
  defining: true,

  addAttributes() {
    return {
      pid: {
        default: null,
        validate: 'string|null',
        keepOnSplit: false,
        parseHTML: (el) => el.getAttribute('data-pid') || null,
        renderHTML: (a) => (typeof a.pid === 'string' && a.pid !== '' ? { 'data-pid': a.pid } : {}),
      },
      kind: {
        default: 'manual',
        validate: 'string',
        parseHTML: (el) => (el.getAttribute('data-kind') === 'auto' ? 'auto' : 'manual'),
        renderHTML: (a) => ({ 'data-kind': a.kind === 'auto' ? 'auto' : 'manual' }),
      },
      columns: {
        default: null,
        validate: 'number|null',
        parseHTML: (el) => columnsFromClass(el),
        renderHTML: () => ({}), // a class, added by the node's renderHTML
      },
      markers: {
        default: [],
        parseHTML: (el) => normalizeMarkers(parseJsonAttribute(el, 'data-markers')),
        renderHTML: (a) => {
          const markers = normalizeMarkers(a.markers);
          return markers.length ? { 'data-markers': JSON.stringify(markers) } : {};
        },
      },
      pageNumber: {
        default: false,
        validate: 'boolean',
        parseHTML: (el) => el.hasAttribute('data-page-number'),
        renderHTML: (a) => (a.pageNumber === true ? { 'data-page-number': '' } : {}),
      },
      footer: {
        default: null,
        validate: 'string|null',
        parseHTML: (el) => el.getAttribute('data-footer'),
        renderHTML: (a) => (typeof a.footer === 'string' ? { 'data-footer': a.footer } : {}),
      },
      objects: {
        default: [],
        parseHTML: (el) => normalizePageObjects(parseJsonAttribute(el, 'data-objects')),
        renderHTML: (a) => {
          const objects = normalizePageObjects(a.objects);
          return objects.length ? { 'data-objects': JSON.stringify(objects) } : {};
        },
      },
      oversized: {
        default: false,
        validate: 'boolean',
        rendered: false,
        keepOnSplit: false,
        parseHTML: () => false,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div.page',
        // Only the flow is content; chrome (markers, objects, footer, number) lives in attrs.
        // Chrome is only span/img, so div.columnWrapper is the flow even if chrome has the class.
        contentElement: (el) =>
          el.querySelector<HTMLElement>(':scope > div.columnWrapper') ?? el,
      },
    ];
  },

  // Used for static HTML export and the clipboard. The editor uses PageView (same DOM shape).
  renderHTML({ node, HTMLAttributes }) {
    const { class: authorClass, ...rest } = HTMLAttributes as Record<string, unknown>;
    const attrs = node.attrs as PageAttrs;
    return [
      'div',
      { class: pageClass(attrs.columns, authorClass), ...rest },
      ...pageChromeSpec(attrs),
      ['div', { class: 'columnWrapper' }, 0],
    ];
  },
});
