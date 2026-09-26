// Oversized pages (plan §4.4, P4.8): a page whose first unit is taller than a column is flagged
// (page.attrs.oversized) and nothing moves. These helpers find the block responsible and offer
// the fixes: make it wide (it spans the columns), allow it to split (it flows over the columns
// of its page), or shrink its images to fit a column.
//
// "Allow splitting" is an inline style on the block, `break-inside: auto` (the themes give
// .block, table and blockquote `break-inside: avoid`), plus `display: block` for theme blocks
// (the themes make .block an inline-block, which never splits). Inline, so it needs no editor
// CSS and exported HTML keeps it; the inspector shows it in the block's style. A block that
// splits flows over the columns of its page; one taller than a whole page stays oversized.
//
// Every action is one transaction of attribute steps (one undo step). Pagination re-checks the
// page, and the flag (and the warning) clears when the block fits.
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, type Command, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { pageAt, pageGeometry, type PageRef } from '../../pagination';
import { normalizeStyle } from '../../schema';

export interface OversizedPage {
  index: number;
  pos: number;
  pid: string | null;
}

/** The pages pagination flagged oversized. */
export function oversizedPages(doc: PMNode): OversizedPage[] {
  const out: OversizedPage[] = [];
  doc.forEach((page, pos, index) => {
    if (page.attrs.oversized === true) out.push({ index, pos, pid: typeof page.attrs.pid === 'string' ? page.attrs.pid : null });
  });
  return out;
}

export interface OffendingBlock {
  /** position before the block */
  pos: number;
  node: PMNode;
}

/**
 * The block that makes page `index` oversized: the unit that starts the page, after the headings
 * kept with it (plan §4.4). Null for a page without blocks.
 */
export function offendingBlock(doc: PMNode, index: number): OffendingBlock | null {
  const page = pageAt(doc, index);
  if (!page) return null;
  let pos = page.contentStart;
  for (let k = 0; k < page.node.childCount; k++) {
    const node = page.node.child(k);
    if (node.type.name !== 'heading' || k === page.node.childCount - 1) return { pos, node };
    pos += node.nodeSize;
  }
  return null;
}

/** Node types a page's columns keep whole (themes: break-inside: avoid) and that can be allowed to split. */
const SPLIT_TYPES = new Set(['themeBlock', 'table', 'blockquote', 'codeBlock']);

const hasClass = (node: PMNode, name: string) => Array.isArray(node.attrs.classes) && (node.attrs.classes as string[]).includes(name);
const styleOf = (node: PMNode): string => (typeof node.attrs.style === 'string' ? node.attrs.style : '');

/** Images inside `node` (positions relative to the document, `pos` = before `node`). */
function imagesIn(node: PMNode, pos: number): { pos: number; node: PMNode }[] {
  const out: { pos: number; node: PMNode }[] = [];
  node.descendants((child, offset) => {
    if (child.type.name === 'image') out.push({ pos: pos + 1 + offset, node: child });
  });
  return out;
}

export interface OversizeFixes {
  /** the block spans the page's columns (class `wide`; the `wide` attribute of a TOC) */
  makeWide: boolean;
  /** the block may split over the page's columns (inline style) */
  allowSplitting: boolean;
  /** the block holds images that can be made smaller */
  shrinkImages: boolean;
}

/**
 * The fixes that apply to page `index`'s offending block. `columns`: the page's column count as
 * laid out (making a block wide on a 1-column page changes nothing); unknown (null) counts as 2.
 */
export function oversizeFixes(state: EditorState, index: number, columns: number | null = null): OversizeFixes {
  const block = offendingBlock(state.doc, index);
  const none = { makeWide: false, allowSplitting: false, shrinkImages: false };
  if (!block) return none;
  const { node } = block;
  const page = state.doc.child(index);
  const multiColumn = (columns ?? (page.attrs.columns === 1 ? 1 : 2)) > 1;
  const wideAttr = node.type.name === 'toc' ? node.attrs.wide !== true : 'classes' in node.attrs && !hasClass(node, 'wide');
  return {
    makeWide: multiColumn && wideAttr,
    allowSplitting: SPLIT_TYPES.has(node.type.name) && !/break-inside:\s*auto/.test(styleOf(node)),
    shrinkImages: imagesIn(node, block.pos).length > 0,
  };
}

/** An oversized page with what the warning says and offers. */
export interface OversizeWarning extends OversizedPage {
  /** the offending block, for the message ("Theme block “monster”") */
  label: string;
  fixes: OversizeFixes;
}

/**
 * The warnings for every oversized page. `columnsOf(index)`: the page's laid-out column count
 * (pageColumns), when a view is at hand.
 */
export function oversizeWarnings(state: EditorState, columnsOf?: (index: number) => number | null): OversizeWarning[] {
  return oversizedPages(state.doc).map((page) => {
    const block = offendingBlock(state.doc, page.index);
    return {
      ...page,
      label: block ? describeBlock(block.node) : 'Block',
      fixes: oversizeFixes(state, page.index, columnsOf?.(page.index) ?? null),
    };
  });
}

/** Whether two warning lists show the same thing. */
export function sameWarnings(a: readonly OversizeWarning[], b: readonly OversizeWarning[]): boolean {
  return (
    a.length === b.length &&
    a.every((w, i) => {
      const v = b[i]!;
      return (
        w.index === v.index &&
        w.pid === v.pid &&
        w.pos === v.pos &&
        w.label === v.label &&
        w.fixes.makeWide === v.fixes.makeWide &&
        w.fixes.allowSplitting === v.fixes.allowSplitting &&
        w.fixes.shrinkImages === v.fixes.shrinkImages
      );
    })
  );
}

/** The laid-out column count of page `index` (themes and :has() rules can change it), or null. */
export function pageColumns(view: EditorView, index: number): number | null {
  const page = pageAt(view.state.doc, index);
  return page ? (pageGeometry(view, page)?.columns ?? null) : null;
}

/** Makes page `index`'s offending block wide. */
export function makeWide(index: number): Command {
  return (state, dispatch) => {
    const block = offendingBlock(state.doc, index);
    if (!block || !oversizeFixes(state, index).makeWide) return false;
    if (dispatch) {
      const tr = state.tr;
      if (block.node.type.name === 'toc') tr.setNodeAttribute(block.pos, 'wide', true);
      else tr.setNodeAttribute(block.pos, 'classes', [...(block.node.attrs.classes as string[]), 'wide']);
      dispatch(tr);
    }
    return true;
  };
}

/** Allows page `index`'s offending block to split over the page's columns (see the top). */
export function allowSplitting(index: number): Command {
  return (state, dispatch) => {
    const block = offendingBlock(state.doc, index);
    if (!block || !SPLIT_TYPES.has(block.node.type.name) || /break-inside:\s*auto/.test(styleOf(block.node))) return false;
    if (dispatch) {
      const extra = block.node.type.name === 'themeBlock' ? 'display: block; break-inside: auto;' : 'break-inside: auto;';
      const style = normalizeStyle(`${styleOf(block.node)}; ${extra}`.replace(/^;\s*/, ''));
      dispatch(state.tr.setNodeAttribute(block.pos, 'style', style));
    }
    return true;
  };
}

/** A style with `width` set and `height: auto` (other declarations kept). */
function withWidth(style: string, width: number): string | null {
  const kept = style
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d && !/^(width|height|max-width)\s*:/i.test(d));
  return normalizeStyle([...kept, `width: ${width}px`, 'height: auto'].join('; '));
}

/**
 * Shrinks the images of page `index`'s offending block, all by the same factor, so the block fits
 * a column (with a little room). Needs the rendered page (the view) to measure. One undo step.
 */
export function shrinkImages(index: number): Command {
  return (state, dispatch, view) => {
    const block = offendingBlock(state.doc, index);
    if (!block || !view) return false;
    const images = imagesIn(block.node, block.pos);
    if (images.length === 0) return false;
    const plan = shrinkPlan(view, pageAt(state.doc, index)!, block, images);
    if (!plan) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const { pos, width } of plan) tr.setNodeAttribute(pos, 'style', withWidth(styleOf(tr.doc.nodeAt(pos)!), width));
      dispatch(tr);
    }
    return true;
  };
}

/** New CSS widths (px) for the images, or null when they can't be measured or already fit. */
function shrinkPlan(view: EditorView, page: PageRef, block: OffendingBlock, images: { pos: number; node: PMNode }[]): { pos: number; width: number }[] | null {
  const g = pageGeometry(view, page);
  const blockEl = view.nodeDOM(block.pos);
  if (!g || !(blockEl instanceof HTMLElement)) return null;
  const boxes = images.map((image) => {
    const el = view.nodeDOM(image.pos);
    return el instanceof HTMLElement ? el.getBoundingClientRect() : null;
  });
  if (boxes.some((b) => !b || b.height <= 0)) return null;
  const imageHeight = boxes.reduce((sum, b) => sum + b!.height, 0);
  const blockHeight = Array.from(blockEl.getClientRects()).reduce((sum, r) => sum + r.height, 0);
  const room = g.box.height * 0.95 - (blockHeight - imageHeight);
  const factor = Math.min(1, room / imageHeight);
  if (!(factor > 0) || factor >= 0.999) return null;
  // Widths in CSS px: client px divided by the canvas zoom.
  return images.map((image, k) => ({ pos: image.pos, width: Math.max(16, Math.floor((boxes[k]!.width / g.scale) * factor)) }));
}

/** Puts the cursor at the start of page `index` (the block is selected when it can't hold a cursor). */
export function goToPage(index: number): Command {
  return (state, dispatch) => {
    const page = pageAt(state.doc, index);
    if (!page) return false;
    if (dispatch) {
      const block = offendingBlock(state.doc, index);
      const selection =
        block && !block.node.isTextblock && NodeSelection.isSelectable(block.node)
          ? NodeSelection.create(state.doc, block.pos)
          : Selection.near(state.doc.resolve(page.contentStart));
      dispatch(state.tr.setSelection(selection).scrollIntoView());
    }
    return true;
  };
}

/** A short description of the offending block for the warning ("Theme block “monster”", "Table"…). */
export function describeBlock(node: PMNode): string {
  const classes = Array.isArray(node.attrs.classes) ? (node.attrs.classes as string[]).filter((c) => c !== 'wide') : [];
  const named = (label: string) => (classes.length ? `${label} “${classes.join(' ')}”` : label);
  switch (node.type.name) {
    case 'themeBlock':
      return named('Theme block');
    case 'table':
      return 'Table';
    case 'blockquote':
      return 'Quote';
    case 'codeBlock':
      return 'Code block';
    case 'paragraph':
      return node.textContent ? 'Paragraph' : 'Image';
    case 'heading':
      return 'Heading';
    case 'bulletList':
    case 'orderedList':
      return 'List item';
    case 'toc':
      return 'Table of contents';
    case 'rawHtml':
      return 'HTML block';
    default:
      return 'Block';
  }
}
