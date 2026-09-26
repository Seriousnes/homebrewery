// Test helpers for pagination (pure ProseMirror, no DOM). Not used by the app.
import type { Attrs, Node as PMNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { schema } from '../schema/testing';
import { isAutoPage, isPlaceholderPage, normalizeCut, pageAt, rejoinContinuations, type PageRef } from './boundary';
import { keepWithNext, type CutChoice } from './cut';
import type { PageLayout } from './step';

export { schema };

const type = (name: string) => {
  const t = schema.nodes[name];
  if (!t) throw new Error(`no node type ${name}`);
  return t;
};

export const txt = (value: string) => schema.text(value);

/** paragraph */
export const P = (value: string, attrs: Attrs | null = null): PMNode =>
  type('paragraph').create(attrs, value ? txt(value) : null);
/** paragraph with continuation: true */
export const PC = (value: string, attrs: Attrs = {}): PMNode => P(value, { ...attrs, continuation: true });
export const H = (level: number, value: string, attrs: Attrs = {}): PMNode =>
  type('heading').create({ level, ...attrs }, value ? txt(value) : null);
export const LI = (attrs: Attrs | null, ...content: PMNode[]): PMNode => type('listItem').create(attrs, content);
/** list item holding one paragraph */
export const li = (value: string): PMNode => LI(null, P(value));
export const UL = (attrs: Attrs | null, ...items: PMNode[]): PMNode => type('bulletList').create(attrs, items);
export const OL = (attrs: Attrs | null, ...items: PMNode[]): PMNode => type('orderedList').create(attrs, items);
export const DL = (attrs: Attrs | null, ...items: PMNode[]): PMNode => type('definitionList').create(attrs, items);
export const DT = (value: string, attrs: Attrs | null = null): PMNode => type('definitionTerm').create(attrs, txt(value));
export const DD = (value: string, attrs: Attrs | null = null): PMNode => type('definitionDesc').create(attrs, txt(value));
export const BLOCK = (classes: string[], ...content: PMNode[]): PMNode => type('themeBlock').create({ classes }, content);
export const PAGE = (attrs: Attrs | null, ...blocks: PMNode[]): PMNode => type('page').create(attrs, blocks);
/** auto page */
export const AUTO = (attrs: Attrs | null, ...blocks: PMNode[]): PMNode => PAGE({ kind: 'auto', ...attrs }, ...blocks);
export const DOC = (...pages: PMNode[]): PMNode => type('doc').create(null, pages);

/** Position right before the first character of `needle` (which must occur once in `doc`). */
export function posOf(doc: PMNode, needle: string): number {
  const found: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    let from = 0;
    for (;;) {
      const at = node.text.indexOf(needle, from);
      if (at < 0) break;
      found.push(pos + at);
      from = at + 1;
    }
  });
  if (found.length !== 1) throw new Error(`"${needle}" occurs ${found.length} times`);
  return found[0]!;
}

/** Page index and the text around a position, for readable selection assertions. */
export function describePos(doc: PMNode, pos: number): { page: number; before: string; after: string; parent: string } {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  return {
    page: $pos.index(0),
    before: parent.textBetween(0, $pos.parentOffset),
    after: parent.textBetween($pos.parentOffset, parent.content.size),
    parent: parent.type.name,
  };
}

/** The flow of each page as text blocks, e.g. [['Title', 'Hello'], ['world']]. */
export function pageTexts(doc: PMNode): string[][] {
  const pages: string[][] = [];
  doc.forEach((page) => {
    const blocks: string[] = [];
    page.descendants((node) => {
      if (node.isTextblock) {
        blocks.push(node.textContent);
        return false;
      }
      return true;
    });
    pages.push(blocks);
  });
  return pages;
}

/** All text of the document, fragments joined (what the author sees as one flow). */
export const flowText = (doc: PMNode): string => pageTexts(doc).flat().join('|');

/**
 * The document with every auto page joined into the page before it and continuations
 * re-joined: what pagination must never change. Oversized flags and continuation flags left
 * over (stale ones, away from a page seam) are dropped.
 */
export function canonical(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  for (let i = doc.childCount - 1; i >= 1; i--) {
    if (!isAutoPage(tr.doc.child(i))) continue;
    const page = pageAt(tr.doc, i)!;
    tr.join(page.pos);
    rejoinContinuations(tr, page.pos - 1);
  }
  tr.doc.descendants((node, pos) => {
    if (node.type.name === 'page' && node.attrs.oversized === true) tr.setNodeAttribute(pos, 'oversized', false);
    if (!node.isText && node.attrs.continuation === true) tr.setNodeAttribute(pos, 'continuation', false);
    return !node.isTextblock;
  });
  return tr.doc;
}

/** The attributes every fragment of a split block shares: all but the flag, the id and list numbering. */
function sharedAttrs(attrs: Attrs): string {
  const { continuation: _c, id: _id, start: _start, ...rest } = attrs as Record<string, unknown>;
  return JSON.stringify(rest);
}

/**
 * What canonical() can't see (it keeps the head's attributes and joins every fragment), at each
 * seam between a page and the auto page after it: fragments of one block whose attributes
 * differ, a continued ordered list that doesn't start at the next number, and a heading left at
 * the bottom of a page apart from the block after it. Empty when the seams are right.
 */
export function seamProblems(doc: PMNode): string[] {
  const problems: string[] = [];
  for (let i = 0; i + 1 < doc.childCount; i++) {
    const page = doc.child(i);
    const next = doc.child(i + 1);
    if (!isAutoPage(next)) continue;
    let headings = 0;
    while (headings < page.childCount && page.child(page.childCount - 1 - headings).type.name === 'heading') headings++;
    if (headings > 0 && headings < page.childCount) problems.push(`page ${i} ends with a heading, apart from what follows it`);
    let before: PMNode | null = page.lastChild;
    let after: PMNode | null = next.firstChild;
    for (let depth = 2; before && after && !after.isText && after.attrs.continuation === true && before.type === after.type; depth++) {
      if (sharedAttrs(before.attrs) !== sharedAttrs(after.attrs)) {
        problems.push(`page ${i + 1}: ${after.type.name} fragment (depth ${depth}) has ${sharedAttrs(after.attrs)}, its head ${sharedAttrs(before.attrs)}`);
      }
      if (after.type.name === 'orderedList') {
        const start = typeof before.attrs.start === 'number' ? before.attrs.start : 1;
        const expected = start + before.childCount - (after.firstChild?.attrs.continuation === true ? 1 : 0);
        if (after.attrs.start !== expected) problems.push(`page ${i + 1}: ordered list continues at ${String(after.attrs.start)}, expected ${expected}`);
      }
      before = before.lastChild;
      after = after.firstChild;
    }
  }
  return problems;
}

// A line-model layout ----------------------------------------------------------------------------
//
// A fake PageLayout for unit tests of the step logic and the scheduler: every column holds
// `lines` lines, a textblock takes ceil(length / chars) lines, other blocks the lines of their
// textblocks. Paragraphs flow line by line across columns; list items and other blocks can't
// split (break-inside: avoid) and move to the next column when they don't fit; headings keep
// with the next block. It mirrors the DOM rules of cut.ts and measure.ts, in lines.

export interface LineLayoutOptions {
  /** lines per column (default 10) */
  lines?: number;
  /**
   * lines per column on even pages (1-based: the 2nd, 4th, …), like a theme that styles odd and
   * even pages differently (default: `lines`). parityMatters() is true when it differs.
   */
  evenLines?: number;
  /** characters per line (default 10) */
  chars?: number;
  /** columns when the page doesn't say (default 2) */
  columns?: number;
  /** pages whose flow holds an image without a size yet (measure returns 'waiting') */
  waiting?: (page: PageRef) => boolean;
  /** pages on screen (PageLayout.isVisible; default: none) */
  visible?: (index: number) => boolean;
}

export interface LineMeasure {
  overflow: boolean;
  columns: number;
  /** first block outside: its index, position, and the first line (or item) outside */
  first: { index: number; pos: number; line: number; item: number } | null;
  lastColumn: number;
  columnFree: number[];
  freeSpace: number;
}

const FLOWING = new Set(['paragraph']);
const LISTS = new Set(['bulletList', 'orderedList']);

export function lineCount(node: PMNode, chars: number): number {
  if (node.isTextblock) return Math.max(1, Math.ceil(node.content.size / chars));
  if (node.isLeaf) return 1;
  let n = 0;
  node.forEach((child) => (n += lineCount(child, chars)));
  return Math.max(1, n);
}

export interface LineLayout extends PageLayout<LineMeasure> {
  /** pages measured so far */
  readonly measured: number;
  /** the pages measured so far, in order: [page index, first block's text] */
  readonly log: [number, string][];
  /** the line measurement of a page (measure without the `waiting` option) */
  lines(page: PageRef): LineMeasure;
}

export function lineLayout(getDoc: () => PMNode, opts: LineLayoutOptions = {}): LineLayout {
  const C = opts.chars ?? 10;
  const columnsOf = (page: PMNode) => (typeof page.attrs.columns === 'number' ? page.attrs.columns : (opts.columns ?? 2));
  const linesOf = (index: number) => (index % 2 === 1 ? (opts.evenLines ?? opts.lines ?? 10) : (opts.lines ?? 10));
  let measured = 0;
  const log: [number, string][] = [];

  function measure(page: PageRef): LineMeasure {
    measured += 1;
    log.push([page.index, page.node.firstChild?.textContent ?? '']);
    const L = linesOf(page.index);
    const cols = columnsOf(page.node);
    let col = 0;
    let used = 0;
    let first: LineMeasure['first'] = null;
    let pos = page.contentStart;
    // An unsplittable unit of n lines; false when it doesn't fit on the page.
    const unit = (n: number): boolean => {
      if (used > 0 && used + n > L) {
        col += 1;
        used = 0;
      }
      if (col >= cols || n > L) return false;
      used += n;
      return true;
    };
    for (let index = 0; index < page.node.childCount && !first; index++) {
      const block = page.node.child(index);
      const blockPos = pos;
      pos += block.nodeSize;
      if (FLOWING.has(block.type.name)) {
        const n = lineCount(block, C);
        for (let line = 0; line < n; line++) {
          if (used >= L) {
            col += 1;
            used = 0;
          }
          if (col >= cols) {
            first = { index, pos: blockPos, line, item: 0 };
            break;
          }
          used += 1;
        }
      } else if (LISTS.has(block.type.name)) {
        for (let item = 0; item < block.childCount; item++) {
          if (!unit(lineCount(block.child(item), C))) {
            first = { index, pos: blockPos, line: 0, item };
            break;
          }
        }
      } else if (!unit(lineCount(block, C))) {
        first = { index, pos: blockPos, line: 0, item: 0 };
      }
    }
    const columnFree = Array.from({ length: cols }, (_, c) => (first ? 0 : c < col ? 0 : c === col ? L - used : L));
    return { overflow: first !== null, columns: cols, first, lastColumn: col, columnFree, freeSpace: columnFree.reduce((a, b) => a + b, 0) };
  }

  function chooseCut(page: PageRef, m: LineMeasure): CutChoice {
    const f = m.first;
    if (!f) return { pos: null, oversized: false, rule: 'none' };
    const doc = getDoc();
    const block = page.node.child(f.index);
    let pos = f.pos;
    let unitEnd = f.pos + block.nodeSize;
    let rule: CutChoice['rule'] = 'block';
    // Lines the unit needs at the top of a fresh page (0: it can split there).
    let unitLines = FLOWING.has(block.type.name) ? 0 : lineCount(block, C);
    if (FLOWING.has(block.type.name) && f.line > 0) {
      pos = f.pos + 1 + Math.min(f.line * C, block.content.size);
      rule = 'line';
    } else if (LISTS.has(block.type.name)) {
      let itemPos = f.pos + 1;
      for (let k = 0; k < f.item; k++) itemPos += block.child(k).nodeSize;
      pos = f.item > 0 ? itemPos : f.pos;
      unitEnd = itemPos + block.child(f.item).nodeSize;
      unitLines = f.item > 0 ? 0 : lineCount(block.child(0), C);
      rule = 'item';
    }
    const inside = (p: number) => p > page.contentStart && p < page.contentEnd;
    pos = normalizeCut(doc, pos);
    const kept = keepWithNext(page, pos);
    if (kept !== pos) {
      // As cut.ts: headings that start the page stay when the unit fits a fresh page.
      if (kept <= page.contentStart && inside(pos) && unitLines <= linesOf(page.index)) return { pos, oversized: false, rule };
      pos = kept;
      rule = 'keepWithNext';
    }
    if (inside(pos)) return { pos, oversized: false, rule };
    if (pos >= page.contentEnd) return { pos: null, oversized: false, rule: 'none' };
    const after = normalizeCut(doc, unitEnd);
    return { pos: inside(after) ? after : null, oversized: true, rule: 'oversized' };
  }

  function pullTarget(_page: PageRef, m: LineMeasure, next: PageRef): number | null {
    if (m.overflow || !isAutoPage(next.node) || isPlaceholderPage(next.node)) return null;
    const free = [...m.columnFree];
    const cols = m.columns;
    let col = m.lastColumn;
    const pulled: { end: number; heading: boolean }[] = [];
    let pos = next.contentStart;
    for (let k = 0; k < next.node.childCount; k++) {
      const block = next.node.child(k);
      const end = pos + block.nodeSize;
      pos = end;
      const n = lineCount(block, C);
      if (FLOWING.has(block.type.name)) {
        let rest = n;
        let c = col;
        while (c < cols && rest > free[c]!) {
          rest -= free[c]!;
          c += 1;
        }
        if (c < cols) {
          for (let j = col; j < c; j++) free[j] = 0;
          free[c] = free[c]! - rest;
          col = c;
          pulled.push({ end, heading: false });
          continue;
        }
        if (free.slice(col).some((f) => f >= 1)) pulled.push({ end, heading: false });
        break;
      }
      let c = col;
      while (c < cols && n > free[c]!) c += 1;
      if (c >= cols) break;
      free[c] = free[c]! - n;
      col = c;
      pulled.push({ end, heading: block.type.name === 'heading' });
    }
    const after = pageAt(getDoc(), next.index + 1);
    const followed = after !== null && isAutoPage(after.node);
    while (pulled.length > 0 && (pulled.length < next.node.childCount || followed) && pulled[pulled.length - 1]!.heading) pulled.pop();
    return pulled.length > 0 ? pulled[pulled.length - 1]!.end : null;
  }

  return {
    measure: (page) => (opts.waiting?.(page) ? 'waiting' : measure(page)),
    lines: measure,
    chooseCut,
    pullTarget,
    parityMatters: () => opts.evenLines !== undefined && opts.evenLines !== (opts.lines ?? 10),
    isVisible: (index) => opts.visible?.(index) ?? false,
    get measured() {
      return measured;
    },
    log,
  };
}
