// DOM ids `p1`, `p2`, … on pages (plan §3.4), so imported #p3 links and the TOC keep working.
//
// renderHTML can't know a page's index, so this plugin's view writes the id on every page element
// after each view update (only where it differs). The ids are not stored in the document; static
// export (P6.4) adds them itself (see pageDomId). The writes are made the way ProseMirror makes its
// own DOM changes, with its DOM observer paused, so it never reads them as an edit (PageView also
// ignores attribute changes of its element; pages rendered by toDOM alone don't).
//
// Not a node decoration (P8.1): a page decoration whose id changes on every page after an added or
// removed page makes ProseMirror's view update match those pages by position instead of identity.
// After a removed page it then re-rendered every later page into the element of the page before
// it (in a theme switch that shrinks the brew, about 2,800 page elements re-created, each with
// its whole flow, and laid out again).
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export const pageIndexIdsKey = new PluginKey('hbPageIndexIds');

/** The DOM id of the page at `index` (0-based): "p1" for the first page. */
export const pageDomId = (index: number): string => `p${index + 1}`;

/** ProseMirror's DOM observer (EditorView internals: stop() and start() bracket its own DOM writes). */
interface DomObserver {
  stop(): void;
  start(): void;
}

function domObserver(view: EditorView): DomObserver | null {
  const observer = (view as unknown as { domObserver?: Partial<DomObserver> }).domObserver;
  return observer && typeof observer.stop === 'function' && typeof observer.start === 'function' ? (observer as DomObserver) : null;
}

/** The page elements whose id differs from p{n}, with the id each needs. */
function staleIds(view: EditorView): [HTMLElement, string][] {
  const { doc } = view.state;
  const root = view.dom;
  const out: [HTMLElement, string][] = [];
  if (root.childElementCount === doc.childCount) {
    // The root holds only the pages (PagesRoot): the k-th element is the k-th page.
    let index = 0;
    for (let el = root.firstElementChild; el; el = el.nextElementSibling, index++) {
      const id = pageDomId(index);
      if (el.id !== id && el instanceof HTMLElement) out.push([el, id]);
    }
    return out;
  }
  doc.forEach((_page, pos, index) => {
    const el = view.nodeDOM(pos);
    if (el instanceof HTMLElement && el.id !== pageDomId(index)) out.push([el, pageDomId(index)]);
  });
  return out;
}

/** Writes p1…pN on the page elements of `view` where they differ. */
export function syncPageDomIds(view: EditorView): void {
  const stale = staleIds(view);
  if (stale.length === 0) return;
  const observer = domObserver(view);
  observer?.stop();
  try {
    for (const [el, id] of stale) el.id = id;
  } finally {
    observer?.start();
  }
}

export const PageIndexIds = Extension.create({
  name: 'hbPageIndexIds',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pageIndexIdsKey,
        view(view) {
          syncPageDomIds(view);
          // Every update: a redraw (new node views, say) re-creates pages without a document
          // change. Reading the ids of a few hundred elements costs microseconds.
          return { update: (v) => syncPageDomIds(v) };
        },
      }),
    ];
  },
});
