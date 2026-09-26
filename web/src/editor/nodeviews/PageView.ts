// PageView: the editor's NodeView for `page` (plan §3.6, §4.9, P3.2).
//
// It emits exactly the DOM of Page.renderHTML (the schema's toDOM is the single source of the
// shape, so the two can't drift apart):
//
//   div.page[.hb-cols-N][.<author classes>][style][data-kind][data-pid]…      ← dom
//     span.inline-block.<marker>        markers (frontCover, skipCounting, …)
//     img / span.inline-block           page objects (absolutely positioned)
//     span.inline-block.footnote        footer (section setting)
//     span.inline-block.pageNumber.auto page number (section setting)
//     div.columnWrapper                 contentDOM: the flow
//     span.hb-oversized-badge           editor only, when attrs.oversized
//
// Editor-only differences from renderHTML:
// - Chrome elements (everything except div.columnWrapper) are contenteditable=false. Page
//   objects also carry data-object-id (for the object tools, P5.3) and images draggable=false.
// - The DOM id is owned by the PageIndexIds plugin (id="p{n}", written on this.dom by its plugin
//   view; not a decoration, see pageIndexIds.ts). PageView never writes `id`, so the page's
//   generic `id` attribute is not rendered in the editor (upstream ignored `\page {#id}` too).
// - attrs.oversized (set by pagination, not rendered by renderHTML) adds the class hb-oversized
//   and a badge after the column wrapper (styled by canvas.css).
//
// update() patches attribute changes in place: the page element and its column wrapper (and so
// the whole flow inside it) are never re-created for an attribute change. Classes are patched
// token by token and only attributes PageView wrote itself are removed, so the id (PageIndexIds)
// and ProseMirror's own classes (ProseMirror-selectednode) survive.
import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model';
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view';
import { normalizeMarkers, normalizePageObjects } from '../schema';

export const OVERSIZED_CLASS = 'hb-oversized';
export const OVERSIZED_BADGE_CLASS = 'hb-oversized-badge';
/** On page-object elements: the PageObject.id (objects are identified by it, not by index). */
export const OBJECT_ID_ATTR = 'data-object-id';
/** On every chrome element PageView renders. */
export const CHROME_ATTR = 'data-hb-chrome';

export const OVERSIZED_BADGE_TEXT = 'Oversized';
export const OVERSIZED_BADGE_TITLE =
  'A block on this page is taller than a column, so it cannot move to another page. Make it smaller, wide, or split it.';

/** Attributes of the page element that PageView never writes (the id is PageIndexIds'). */
const UNMANAGED_ATTRS = new Set(['id', 'class']);

interface RenderedPage {
  dom: HTMLElement;
  contentDOM: HTMLElement;
}

function isElement(node: unknown): node is HTMLElement {
  return typeof node === 'object' && node !== null && (node as Node).nodeType === 1;
}

/** Deep equality for attribute values (JSON data: arrays, plain objects, primitives). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function sameAttrs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!sameValue(a[key], b[key])) return false;
  return true;
}

/** The attributes that decide the chrome (everything rendered before/after the wrapper). */
function chromeKey(attrs: Record<string, unknown>): string {
  return JSON.stringify([attrs.markers, attrs.objects, attrs.footer, attrs.pageNumber, attrs.oversized === true]);
}

export class PageView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;

  private node: PMNode;
  private readonly doc: Document;
  /** Chrome elements currently in this.dom (all children except contentDOM). */
  private chrome: HTMLElement[] = [];
  /** Page-element attributes written from the spec (so stale ones can be removed). */
  private attrNames = new Set<string>();
  /** Class tokens written from the spec (so decoration/ProseMirror classes are left alone). */
  private classTokens: string[] = [];
  private currentChromeKey: string;

  constructor(node: PMNode, view?: EditorView) {
    this.node = node;
    this.doc = view?.dom.ownerDocument ?? document;
    const rendered = this.render(node);
    this.dom = rendered.dom;
    this.contentDOM = rendered.contentDOM;

    // Take over the outer attributes and chrome of the freshly rendered element.
    for (const attr of Array.from(this.dom.attributes)) {
      if (attr.name === 'id') this.dom.removeAttribute('id');
      else if (attr.name !== 'class') this.attrNames.add(attr.name);
    }
    this.classTokens = Array.from(this.dom.classList);
    this.chrome = Array.from(this.dom.children).filter((c): c is HTMLElement => c !== this.contentDOM && isElement(c));
    this.decorateChrome(this.chrome, node);
    this.applyOversized(node);
    this.currentChromeKey = chromeKey(node.attrs);
  }

  /** The page node this view currently shows. */
  get pageNode(): PMNode {
    return this.node;
  }

  /** renderHTML's DOM for `node` (the schema's toDOM), with an empty content hole. */
  private render(node: PMNode): RenderedPage {
    const toDOM = node.type.spec.toDOM;
    if (!toDOM) throw new Error('PageView: the page node type has no toDOM');
    const { dom, contentDOM } = DOMSerializer.renderSpec(this.doc, toDOM(node));
    if (!isElement(dom) || !contentDOM || !isElement(contentDOM)) {
      throw new Error('PageView: page renderHTML must return an element with a content hole');
    }
    return { dom, contentDOM };
  }

  private decorateChrome(elements: HTMLElement[], node: PMNode): void {
    // Chrome order (pageChromeSpec, which renders the normalized lists): markers, objects,
    // footer, page number.
    const markers = normalizeMarkers(node.attrs.markers).length;
    const objects = normalizePageObjects(node.attrs.objects);
    elements.forEach((el, i) => {
      el.setAttribute('contenteditable', 'false');
      el.setAttribute(CHROME_ATTR, '');
      const object = i >= markers ? objects[i - markers] : undefined;
      if (object) {
        el.setAttribute(OBJECT_ID_ATTR, object.id);
        if (el.localName === 'img') el.setAttribute('draggable', 'false');
      }
    });
  }

  private applyOversized(node: PMNode): void {
    const oversized = node.attrs.oversized === true;
    this.dom.classList.toggle(OVERSIZED_CLASS, oversized);
    if (!oversized) return;
    const badge = this.doc.createElement('span');
    badge.className = OVERSIZED_BADGE_CLASS;
    badge.textContent = OVERSIZED_BADGE_TEXT;
    badge.title = OVERSIZED_BADGE_TITLE;
    badge.setAttribute('role', 'status');
    badge.setAttribute('contenteditable', 'false');
    badge.setAttribute(CHROME_ATTR, '');
    this.dom.append(badge); // after the wrapper, so theme rules about the chrome never see it
    this.chrome.push(badge);
  }

  /** Patches this.dom to match `node` without replacing the page or its column wrapper. */
  private patch(node: PMNode): void {
    const { dom: fresh, contentDOM: freshWrapper } = this.render(node);

    // Outer attributes (except id and class): set changed ones, remove the ones no longer rendered.
    const next = new Set<string>();
    for (const attr of Array.from(fresh.attributes)) {
      if (UNMANAGED_ATTRS.has(attr.name)) continue;
      next.add(attr.name);
      if (this.dom.getAttribute(attr.name) !== attr.value) this.dom.setAttribute(attr.name, attr.value);
    }
    for (const name of this.attrNames) if (!next.has(name)) this.dom.removeAttribute(name);
    this.attrNames = next;

    // Classes, token by token.
    const tokens = Array.from(fresh.classList);
    for (const token of this.classTokens) if (!tokens.includes(token)) this.dom.classList.remove(token);
    for (const token of tokens) this.dom.classList.add(token);
    this.classTokens = tokens;

    // Chrome: updated only when what it shows changed; element by element when the same elements
    // are rendered (an object moved, restyled or retexted), else re-built.
    const key = chromeKey(node.attrs);
    if (key !== this.currentChromeKey) {
      const chrome = Array.from(fresh.children).filter((c): c is HTMLElement => c !== freshWrapper && isElement(c));
      if (!this.patchChrome(chrome)) {
        for (const el of this.chrome) el.remove();
        for (const el of chrome) this.dom.insertBefore(el, this.contentDOM);
        this.chrome = chrome;
      }
      this.decorateChrome(this.chrome, node);
      this.applyOversized(node);
      this.currentChromeKey = key;
    }
  }

  /**
   * Updates the current chrome to `fresh` in place when it is the same elements (count and tags,
   * the oversize badge aside): attributes and content copied over, so an object's image isn't
   * loaded and decoded again and the object tools keep their element (P8.1: committing a drag
   * re-created every object of the page, and the selection frame shrank to an unloaded image).
   * Returns false when the chrome has to be re-built. The badge goes (applyOversized adds it back).
   */
  private patchChrome(fresh: HTMLElement[]): boolean {
    const current = this.chrome.filter((el) => !el.classList.contains(OVERSIZED_BADGE_CLASS));
    if (current.length !== fresh.length || current.some((el, i) => el.localName !== fresh[i]!.localName)) return false;
    for (const el of this.chrome) if (!current.includes(el)) el.remove();
    current.forEach((el, i) => {
      const from = fresh[i]!;
      for (const attr of Array.from(el.attributes)) if (!from.hasAttribute(attr.name)) el.removeAttribute(attr.name);
      for (const attr of Array.from(from.attributes)) if (el.getAttribute(attr.name) !== attr.value) el.setAttribute(attr.name, attr.value);
      if (el.innerHTML !== from.innerHTML) el.replaceChildren(...Array.from(from.childNodes));
    });
    this.chrome = current;
    return true;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs !== this.node.attrs && !sameAttrs(node.attrs, this.node.attrs)) this.patch(node);
    this.node = node;
    return true;
  }

  /**
   * Events inside the chrome (page objects, footer, page number, badge) are not ProseMirror's:
   * the object tools (P5.3) handle them. Events on the page itself (its margins) and in the flow
   * are left to ProseMirror, so clicking a page margin still places the caret.
   */
  stopEvent(event: Event): boolean {
    const target = event.target as Node | null;
    if (!target || typeof target.nodeType !== 'number') return false;
    if (target === this.dom || this.contentDOM.contains(target)) return false;
    return this.dom.contains(target);
  }

  /**
   * ProseMirror only needs to see mutations in the flow. Changes to the page element's
   * attributes, the chrome and the wrapper's own attributes are the view's (or the object
   * tools') business. Selection changes are always ProseMirror's.
   */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    const { target } = mutation;
    if (target === this.contentDOM) return mutation.type === 'attributes';
    if (this.contentDOM.contains(target)) return false;
    // Someone removed the column wrapper itself: let ProseMirror redraw the page.
    if (mutation.type === 'childList' && target === this.dom) {
      return !Array.from(mutation.removedNodes).includes(this.contentDOM);
    }
    return true;
  }
}
