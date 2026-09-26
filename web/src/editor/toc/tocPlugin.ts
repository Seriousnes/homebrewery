// Keeps every live table of contents up to date (plan §6.5): after pagination settles (page
// numbers are final then), after document changes (in editors without pagination) and after
// restyles (REPAGINATE: theme or CSS changed, so --TOC may too). The toc NodeViews (TocView)
// register here; a refresh computes their entries and re-renders the ones that changed. A toc
// whose height changed asks pagination to check its page again (bounded, so a toc that keeps
// resizing can't loop).
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { PAGINATE, REPAGINATE, isSettled, paginationState } from '../pagination/state';
import { repaginate } from '../pagination/plugin';
import { tocEntries, tocKeyword, type TocEntry, type TocHeading } from './computeToc';

/** What the refresher needs from a toc NodeView. */
export interface TocTarget {
  readonly node: PMNode;
  readonly dom: HTMLElement;
  /** Renders `entries`; returns whether anything changed. */
  setEntries(entries: readonly TocEntry[]): boolean;
  /** Whether the view has been refreshed with the theme's exclusions at least once. */
  refreshed: boolean;
}

interface TocPluginState {
  /** Author edits (doc changes that aren't pagination). */
  edits: number;
  /** REPAGINATE requests (theme, CSS, fonts). */
  restyles: number;
}

export const tocPluginKey = new PluginKey<TocPluginState>('hbToc');

/** How many times in a row (without an author edit) a toc may ask for repagination. */
export const MAX_TOC_REPAGINATIONS = 3;

const registry = new WeakMap<EditorView, Set<TocTarget>>();
const scheduled = new WeakSet<EditorView>();
const repaginations = new WeakMap<EditorView, { edits: number; count: number }>();

export function registerToc(view: EditorView, target: TocTarget): void {
  let set = registry.get(view);
  if (!set) registry.set(view, (set = new Set()));
  set.add(target);
  scheduleTocRefresh(view);
}

export function unregisterToc(view: EditorView, target: TocTarget): void {
  registry.get(view)?.delete(target);
}

/** The registered toc views of an editor (tests, dev pages). */
export const tocTargets = (view: EditorView): TocTarget[] => [...(registry.get(view) ?? [])];

/** Refreshes the tocs of `view` in a microtask (after the current transaction, before paint). */
export function scheduleTocRefresh(view: EditorView): void {
  if (scheduled.has(view)) return;
  scheduled.add(view);
  queueMicrotask(() => {
    scheduled.delete(view);
    refreshTocs(view);
  });
}

/**
 * Theme verdicts (isExcludedByTheme) remembered per page node, page index and heading position in
 * the page, until the next restyle (P8.1): the TOC refreshes after every settle, and a page the
 * author didn't touch keeps its node. The index is part of the key: page rules such as
 * .page:nth-child(odd) can decide the verdict.
 */
const verdictCache = new WeakMap<EditorView, { restyles: number; pages: WeakMap<PMNode, Map<string, boolean>> }>();

function cachedVerdicts(view: EditorView): WeakMap<PMNode, Map<string, boolean>> {
  const restyles = tocPluginKey.getState(view.state)?.restyles ?? 0;
  let cache = verdictCache.get(view);
  if (!cache || cache.restyles !== restyles) {
    cache = { restyles, pages: new WeakMap() };
    verdictCache.set(view, cache);
  }
  return cache.pages;
}

/** The entries each toc was last given by a refresh (an unchanged toc is left alone; positions don't render). */
const lastEntries = new WeakMap<TocTarget, readonly TocEntry[]>();

const sameEntries = (a: readonly TocEntry[] | undefined, b: readonly TocEntry[]): boolean =>
  a !== undefined &&
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i]!;
    return x.level === y.level && x.nest === y.nest && x.text === y.text && x.href === y.href && x.page === y.page;
  });

/** The theme's verdict on a heading: computed --TOC of its element is 'exclude'. */
export function isExcludedByTheme(view: EditorView, heading: TocHeading): boolean {
  let dom: Node | null;
  try {
    dom = view.nodeDOM(heading.pos);
  } catch {
    return false;
  }
  if (!(dom instanceof HTMLElement) || !dom.isConnected) return false;
  const win = dom.ownerDocument.defaultView ?? window;
  return tocKeyword(win.getComputedStyle(dom).getPropertyValue('--TOC')) === 'exclude';
}

/**
 * Computes and renders the entries of every registered toc of `view`. Tocs already shown with
 * the theme's exclusions wait while pagination is busy (their numbers would still move).
 * Returns the number of tocs that changed.
 */
export function refreshTocs(view: EditorView): number {
  if (view.isDestroyed) return 0;
  const targets = registry.get(view);
  if (!targets?.size) return 0;
  const settled = isSettled(view.state);
  const doc = view.state.doc;
  const cache = cachedVerdicts(view);
  let pageStarts: number[] | null = null;
  const isExcluded = (heading: TocHeading) => {
    if (!pageStarts) {
      pageStarts = [];
      doc.forEach((_page, offset) => pageStarts!.push(offset));
    }
    const page = doc.child(heading.page);
    let verdicts = cache.get(page);
    if (!verdicts) cache.set(page, (verdicts = new Map<string, boolean>()));
    const key = `${heading.page}:${heading.pos - pageStarts[heading.page]!}`;
    let v = verdicts.get(key);
    if (v === undefined) verdicts.set(key, (v = isExcludedByTheme(view, heading)));
    return v;
  };
  let changed = 0;
  let firstPage: number | null = null;
  for (const target of targets) {
    if (!settled && target.refreshed) continue;
    if (!target.dom.isConnected) continue;
    const depth = Number(target.node.attrs.depth) || 3;
    const entries = tocEntries(doc, { depth, isExcluded });
    // Nothing to render (most refreshes: a keystroke that moved no heading to another page), and
    // no layout read for the height.
    if (target.refreshed && sameEntries(lastEntries.get(target), entries)) continue;
    lastEntries.set(target, entries);
    const before = target.dom.offsetHeight;
    if (!target.setEntries(entries)) {
      target.refreshed = true;
      continue;
    }
    target.refreshed = true;
    changed++;
    if (target.dom.offsetHeight !== before) {
      let pos: number;
      try {
        pos = view.posAtDOM(target.dom, 0);
      } catch {
        continue;
      }
      const page = doc.resolve(Math.max(0, Math.min(pos, doc.content.size))).index(0);
      firstPage = firstPage === null ? page : Math.min(firstPage, page);
    }
  }
  if (firstPage !== null && paginationState(view.state)) {
    const edits = tocPluginKey.getState(view.state)?.edits ?? 0;
    const last = repaginations.get(view);
    const count = last && last.edits === edits ? last.count + 1 : 1;
    repaginations.set(view, { edits, count });
    if (count <= MAX_TOC_REPAGINATIONS) repaginate(view, firstPage);
  }
  return changed;
}

/** The plugin (added by the toc node extension, TocWithView). */
export function tocPlugin(): Plugin<TocPluginState> {
  return new Plugin<TocPluginState>({
    key: tocPluginKey,
    state: {
      init: () => ({ edits: 0, restyles: 0 }),
      apply(tr, value) {
        const edit = tr.docChanged && !tr.getMeta(PAGINATE);
        const restyle = tr.getMeta(REPAGINATE) !== undefined;
        if (!edit && !restyle) return value;
        return { edits: value.edits + (edit ? 1 : 0), restyles: value.restyles + (restyle ? 1 : 0) };
      },
    },
    view(view) {
      let lastDoc = view.state.doc;
      let lastSettles = paginationState(view.state)?.stats.settles ?? 0;
      let lastRestyles = 0;
      const pending = (state: EditorState) =>
        state.doc !== lastDoc ||
        (paginationState(state)?.stats.settles ?? 0) !== lastSettles ||
        (tocPluginKey.getState(state)?.restyles ?? 0) !== lastRestyles;
      return {
        update(v) {
          if (!registry.get(v)?.size || !isSettled(v.state) || !pending(v.state)) return;
          lastDoc = v.state.doc;
          lastSettles = paginationState(v.state)?.stats.settles ?? 0;
          lastRestyles = tocPluginKey.getState(v.state)?.restyles ?? 0;
          scheduleTocRefresh(v);
        },
      };
    },
  });
}
