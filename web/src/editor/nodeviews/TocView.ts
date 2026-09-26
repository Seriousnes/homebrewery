// NodeView of the live table of contents (plan §6.5, P5.4). The toc node is an atom; its
// entries are computed from the document (toc/computeToc.ts) and rendered as upstream's TOC
// snippet rendered them (toc/renderToc.ts), so the theme's dot leaders apply. The refresher
// (toc/tocPlugin.ts) re-renders it after pagination settles. Clicking an entry (or Enter on a
// focused entry) moves the cursor to the heading and scrolls it to the top.
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { tocEntries, type TocEntry } from '../toc/computeToc';
import { tocClass, tocInnerHtml } from '../toc/renderToc';
import { registerToc, scheduleTocRefresh, unregisterToc, type TocTarget } from '../toc/tocPlugin';

/** data attribute with the number of entries (tests, debugging). */
export const TOC_ENTRIES_ATTR = 'data-toc-entries';

export class TocView implements NodeView, TocTarget {
  readonly dom: HTMLElement;
  node: PMNode;
  refreshed = false;
  private readonly view: EditorView;
  private html = '';

  constructor(node: PMNode, view: EditorView) {
    this.node = node;
    this.view = view;
    this.dom = document.createElement('div');
    this.dom.setAttribute('contenteditable', 'false');
    this.applyAttrs();
    // First render from the document alone; the refresh (a microtask later) applies the theme's
    // --TOC exclusions.
    this.setEntries(tocEntries(view.state.doc, { depth: this.depth }));
    this.dom.addEventListener('click', this.onClick);
    registerToc(view, this);
  }

  private get depth(): number {
    return Number(this.node.attrs.depth) || 3;
  }

  private applyAttrs(): void {
    // classList, not className: ProseMirror's selected-node class must survive.
    for (const cls of tocClass(true).split(' ')) this.dom.classList.remove(cls);
    for (const cls of tocClass(Boolean(this.node.attrs.wide)).split(' ')) this.dom.classList.add(cls);
    this.dom.setAttribute('data-depth', String(this.depth));
  }

  setEntries(entries: readonly TocEntry[]): boolean {
    const title = typeof this.node.attrs.title === 'string' ? this.node.attrs.title : 'Contents';
    const html = tocInnerHtml(title, entries);
    if (html === this.html) return false;
    this.html = html;
    this.dom.innerHTML = html;
    this.dom.setAttribute(TOC_ENTRIES_ATTR, String(entries.length));
    return true;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const old = this.node;
    this.node = node;
    if (old.attrs.wide !== node.attrs.wide || old.attrs.depth !== node.attrs.depth) this.applyAttrs();
    if (old.attrs.title !== node.attrs.title || old.attrs.depth !== node.attrs.depth) {
      this.refreshed = false;
      scheduleTocRefresh(this.view);
    }
    return true;
  }

  /** The entries are ours: ProseMirror must not re-read them. */
  ignoreMutation(): boolean {
    return true;
  }

  /** Clicks on entries are handled here; everything else (selecting the node) by ProseMirror. */
  stopEvent(event: Event): boolean {
    return event.type === 'click' && event.target instanceof Element && event.target.closest('a[href]') !== null;
  }

  destroy(): void {
    this.dom.removeEventListener('click', this.onClick);
    unregisterToc(this.view, this);
  }

  private readonly onClick = (event: MouseEvent): void => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || !this.dom.contains(link)) return;
    event.preventDefault();
    navigateToTarget(this.view, link.getAttribute('href') ?? '');
  };
}

/** Position of the heading with `id`, or null. */
function headingWithId(doc: PMNode, id: string): number | null {
  let target: number | null = null;
  doc.descendants((node, pos) => {
    if (target !== null) return false;
    if (node.type.name === 'heading' && node.attrs.id === id) {
      target = pos;
      return false;
    }
    return !node.isTextblock;
  });
  return target;
}

/** `text` percent-decoded, or null when it isn't valid percent-encoding ('50%-off'). */
function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/**
 * Moves the cursor to the heading with the id in `href` ('#id', or '#p<n>' for a page). The TOC
 * writes ids as they are, so the literal id comes first (an id may hold '%': review finding UI-12);
 * a percent-encoded href (pasted or legacy content) is decoded as a fallback.
 */
export function navigateToTarget(view: EditorView, href: string): boolean {
  const raw = href.replace(/^#/, '');
  if (!raw) return false;
  const doc = view.state.doc;
  let id = raw;
  let target = headingWithId(doc, raw);
  const alt = target === null ? decoded(raw) : null;
  if (alt !== null && alt !== raw) {
    target = headingWithId(doc, alt);
    if (target !== null || /^p\d+$/.test(alt)) id = alt;
  }
  const page = /^p(\d+)$/.exec(id);
  if (target === null && page) {
    const index = Number(page[1]) - 1;
    if (index >= 0 && index < doc.childCount) {
      let pos = 0;
      for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
      target = pos;
    }
  }
  if (target === null) return false;
  const pos: number = target;
  view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(pos + 1), 1)));
  const dom = view.nodeDOM(pos);
  if (dom instanceof HTMLElement && typeof dom.scrollIntoView === 'function') dom.scrollIntoView({ block: 'start', inline: 'nearest' });
  if (view.editable) view.focus();
  return true;
}
