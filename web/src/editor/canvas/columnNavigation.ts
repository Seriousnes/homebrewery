// ArrowUp / ArrowDown inside CSS columns and across pages (plan §13, risk 1; S1).
//
// Browsers move the caret vertically by geometry, and multi-column layout confuses them. S1
// measured (Chromium 1.63 build, Firefox, 5ePHB, /dev/canvas):
//   - Firefox: ArrowDown on the last line of column 1 doesn't move; ArrowUp on the first line of
//     column 2 jumps to the page's first heading; ArrowDown on the last line of a page jumps to
//     the start of the document.
//   - Chromium: columns are right, but ArrowDown from the last line of a page lands on the second
//     line of the next page, at its start.
// So vertical movement is done here, in logical (document) order, like a word processor: the
// next line of the last line of a column is the first line of the next column (or of the next
// row after a spanner, or of the next page), and the caret keeps its horizontal offset within
// the column (the "goal column", kept across repeated presses).
//
// Only text selections in textblocks are handled (Shift extends). A selectable block node next
// to the line (hr, column break, spacer…) becomes a node selection, as ProseMirror does.
// Everything else is left to ProseMirror and the browser: node selections, gap cursors, tables
// (prosemirror-tables moves between cells), IME composition and modifier keys.
import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface ColumnNavState {
  /**
   * Screen x the caret aims for, in the frame of the column the caret is in, and the head it
   * was set for (reset by any other move).
   */
  goalX: number | null;
  head: number | null;
}

export const columnNavigationKey = new PluginKey<ColumnNavState>('hbColumnNavigation');

interface Rect {
  left: number;
  top: number;
  bottom: number;
}

interface ColumnGeometry {
  page: number;
  left: number;
  width: number;
  columnWidth: number;
  gap: number;
}

interface LineInfo {
  rect: Rect;
  page: number;
  column: number;
  /** The line belongs to a block wider than one column (a spanner such as .wide or 5ePHB h1). */
  spanning: boolean;
}

class Geometry {
  private readonly pages = new Map<number, ColumnGeometry | null>();
  private readonly coords = new Map<number, Rect | null>();
  private readonly spans = new Map<number, boolean>();

  private readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
  }

  coordsAt(pos: number): Rect | null {
    if (this.coords.has(pos)) return this.coords.get(pos)!;
    let rect: Rect | null;
    try {
      const c = this.view.coordsAtPos(pos, 1);
      rect = { left: c.left, top: c.top, bottom: c.bottom };
    } catch {
      rect = null;
    }
    this.coords.set(pos, rect);
    return rect;
  }

  pageOf(pos: number): number {
    return this.view.state.doc.resolve(pos).index(0);
  }

  columns(page: number): ColumnGeometry | null {
    if (this.pages.has(page)) return this.pages.get(page)!;
    let geometry: ColumnGeometry | null = null;
    const doc = this.view.state.doc;
    if (page < doc.childCount) {
      let start = 0;
      for (let i = 0; i < page; i++) start += doc.child(i).nodeSize;
      const pageEl = this.view.nodeDOM(start);
      const wrapper = pageEl instanceof HTMLElement ? pageEl.querySelector<HTMLElement>(':scope > div.columnWrapper') : null;
      if (wrapper) {
        const r = wrapper.getBoundingClientRect();
        const cs = getComputedStyle(wrapper);
        const scale = wrapper.offsetWidth ? r.width / wrapper.offsetWidth : 1;
        const px = (v: string) => (parseFloat(v) || 0) * scale;
        const left = r.left + px(cs.paddingLeft) + px(cs.borderLeftWidth);
        const width = r.width - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth);
        const count = Math.max(1, parseInt(cs.columnCount, 10) || 1);
        const gap = cs.columnGap === 'normal' ? px(cs.fontSize) : px(cs.columnGap);
        geometry = { page, left, width, gap, columnWidth: (width - (count - 1) * gap) / count };
      }
    }
    this.pages.set(page, geometry);
    return geometry;
  }

  columnIndex(page: number, x: number): number {
    const g = this.columns(page);
    if (!g) return 0;
    return Math.max(0, Math.floor((x - g.left + g.gap / 2) / (g.columnWidth + g.gap)));
  }

  columnLeft(page: number, column: number): number {
    const g = this.columns(page);
    return g ? g.left + column * (g.columnWidth + g.gap) : 0;
  }

  /** Whether the textblock around `pos` is wider than a column (a column-span: all block). */
  spanning(pos: number): boolean {
    const $pos = this.view.state.doc.resolve(pos);
    const start = $pos.start($pos.depth) - 1;
    if (this.spans.has(start)) return this.spans.get(start)!;
    const g = this.columns(this.pageOf(pos));
    const dom = start >= 0 ? this.view.nodeDOM(start) : null;
    // Per fragment: a paragraph split over two columns has a bounding box two columns wide.
    const spanning = !!g && dom instanceof HTMLElement && Array.from(dom.getClientRects()).some((r) => r.width > g.columnWidth + g.gap / 2);
    this.spans.set(start, spanning);
    return spanning;
  }

  line(pos: number): LineInfo | null {
    const rect = this.coordsAt(pos);
    if (!rect) return null;
    const page = this.pageOf(pos);
    return { rect, page, column: this.columnIndex(page, rect.left), spanning: this.spanning(pos) };
  }
}

function sameLine(a: LineInfo, b: LineInfo): boolean {
  if (a.page !== b.page) return false;
  if (!a.spanning && !b.spanning && a.column !== b.column) return false;
  const overlap = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
  const height = Math.min(a.rect.bottom - a.rect.top, b.rect.bottom - b.rect.top) || 1;
  return overlap > height / 2;
}

const inTableCell = (state: EditorState, pos: number): boolean => {
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec.tableRole as string | undefined;
    if (role === 'cell' || role === 'header_cell') return true;
  }
  return false;
};

/**
 * The textblock position range [start, end] around `pos`, or null outside textblocks.
 */
function textblockRange(state: EditorState, pos: number): { start: number; end: number } | null {
  const $pos = state.doc.resolve(pos);
  if (!$pos.parent.inlineContent) return null;
  return { start: $pos.start(), end: $pos.end() };
}

/**
 * The first position of the line after `head`'s line (dir 1), or the last position of the line
 * before it (dir -1). A Selection when the neighbouring block is a node selection target, null
 * when there is none.
 */
function neighbourLinePos(state: EditorState, geo: Geometry, head: number, dir: 1 | -1): number | Selection | null {
  const range = textblockRange(state, head);
  const current = geo.line(head);
  if (!range || !current) return null;
  // Within the textblock: step until the line changes.
  for (let pos = head + dir; pos >= range.start && pos <= range.end; pos += dir) {
    const line = geo.line(pos);
    if (line && !sameLine(line, current)) return pos;
  }
  // The next/previous textblock (or a selectable node, which ProseMirror selects).
  const edge = state.doc.resolve(dir > 0 ? range.end + 1 : range.start - 1);
  const next = Selection.findFrom(edge, dir);
  if (!next) return null;
  if (!(next instanceof TextSelection)) return next;
  return next.head;
}

/** On the line of `linePos`, the position whose caret is closest to screen x `x`. */
function closestOnLine(state: EditorState, geo: Geometry, linePos: number, x: number): number {
  const range = textblockRange(state, linePos);
  const target = geo.line(linePos);
  if (!range || !target) return linePos;
  let best = linePos;
  let bestDist = Math.abs(target.rect.left - x);
  for (const dir of [1, -1] as const) {
    for (let pos = linePos + dir; pos >= range.start && pos <= range.end; pos += dir) {
      const line = geo.line(pos);
      if (!line || !sameLine(line, target)) break;
      const dist = Math.abs(line.rect.left - x);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
  }
  return best;
}

export type VerticalTarget = { pos: number; goalX: number } | { node: Selection };

/**
 * Where ArrowUp (dir -1) / ArrowDown (dir 1) moves the caret: a text position (with the goal x
 * to keep), a node selection, or null to leave the key to ProseMirror and the browser.
 */
export function verticalTarget(view: EditorView, dir: 1 | -1, goalX: number | null): VerticalTarget | null {
  const { state } = view;
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return null;
  const head = selection.head;
  if (!state.doc.resolve(head).parent.inlineContent || inTableCell(state, head)) return null;

  const geo = new Geometry(view);
  const current = geo.line(head);
  if (!current) return null;
  const x = goalX ?? current.rect.left;

  const neighbour = neighbourLinePos(state, geo, head, dir);
  if (neighbour === null) return null;
  if (typeof neighbour !== 'number') return { node: neighbour };
  const target = geo.line(neighbour);
  if (!target) return null;

  // Keep the offset within the column when the line is in another column or on another page.
  let tx = x;
  if (!current.spanning && !target.spanning && (target.column !== current.column || target.page !== current.page)) {
    tx = x - geo.columnLeft(current.page, current.column) + geo.columnLeft(target.page, target.column);
  }

  // Ask the browser for the position under (tx, middle of the target line); accept it only if it
  // is on that line, otherwise walk the line.
  let pos: number | null = null;
  const hit = view.posAtCoords({ left: tx, top: (target.rect.top + target.rect.bottom) / 2 });
  if (hit) {
    const line = geo.line(hit.pos);
    const $hit = state.doc.resolve(hit.pos);
    if (line && $hit.parent.inlineContent && sameLine(line, target)) pos = hit.pos;
  }
  pos ??= closestOnLine(state, geo, neighbour, tx);
  // The goal is kept in the target column's frame, so the next move translates from there.
  return { pos, goalX: tx };
}

function moveVertically(view: EditorView, dir: 1 | -1, extend: boolean): boolean {
  if (view.composing) return false;
  const nav = columnNavigationKey.getState(view.state);
  const head = view.state.selection.head;
  const goal = nav && nav.head === head ? nav.goalX : null;
  const target = verticalTarget(view, dir, goal);
  if (target === null) return false;
  const { state } = view;
  if ('node' in target) {
    if (extend) return false;
    view.dispatch(state.tr.setSelection(target.node).scrollIntoView());
    return true;
  }
  const anchor = extend ? state.selection.anchor : target.pos;
  const tr: Transaction = state.tr
    .setSelection(TextSelection.create(state.doc, anchor, target.pos))
    .setMeta(columnNavigationKey, { goalX: target.goalX, head: target.pos })
    .scrollIntoView();
  view.dispatch(tr);
  return true;
}

/** Vertical caret movement across CSS columns and pages (see the file header). */
export const ColumnNavigation = Extension.create({
  name: 'hbColumnNavigation',
  // Before the gap cursor and table plugins, which only act where this one doesn't.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin<ColumnNavState>({
        key: columnNavigationKey,
        state: {
          init: () => ({ goalX: null, head: null }),
          apply(tr, prev) {
            const own = tr.getMeta(columnNavigationKey) as ColumnNavState | undefined;
            if (own) return own;
            if (tr.selectionSet || tr.docChanged) return prev.head === null ? prev : { goalX: null, head: null };
            return prev;
          },
        },
        props: {
          handleKeyDown(view, event) {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
            if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return false;
            return moveVertically(view, event.key === 'ArrowDown' ? 1 : -1, event.shiftKey);
          },
        },
      }),
    ];
  },
});
