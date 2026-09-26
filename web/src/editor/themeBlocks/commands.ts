// Theme block commands (plan §6.4, P5.2). A toggle is one transaction with one attribute step
// on the block (never setNodeMarkup: pagination can re-split blocks, and AttrSteps map through
// that; implementation-notes "Pagination core"), with history closed first: one undo step.
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

export type ThemeBlockToggle = 'wide' | 'frame';

/** The theme block at `pos`, or null. */
export function themeBlockAt(doc: PMNode, pos: number): PMNode | null {
  const node = doc.nodeAt(pos);
  return node?.type.name === 'themeBlock' ? node : null;
}

/** Classes of a theme block (author classes; `block` itself is implied). */
export const blockClasses = (node: PMNode): string[] => (Array.isArray(node.attrs.classes) ? [...(node.attrs.classes as string[])] : []);

/**
 * Adds or removes `cls` on the theme block at `pos` (`on` forces a state). Null when there is no
 * block there or nothing changes.
 */
export function toggleThemeBlockClassTr(state: EditorState, pos: number, cls: string, on?: boolean): Transaction | null {
  const node = themeBlockAt(state.doc, pos);
  if (!node) return null;
  const classes = blockClasses(node);
  const has = classes.includes(cls);
  const want = on ?? !has;
  if (want === has) return null;
  const next = want ? [...classes, cls] : classes.filter((c) => c !== cls);
  return closeHistory(state.tr.setNodeAttribute(pos, 'classes', next));
}

/** The innermost theme block around the selection head (or the selected block): its position. */
export function activeThemeBlockPos(state: EditorState): number | null {
  const sel = state.selection as EditorState['selection'] & { node?: PMNode };
  if (sel.node?.type.name === 'themeBlock') return sel.from;
  const $head = sel.$head;
  for (let d = $head.depth; d > 0; d--) if ($head.node(d).type.name === 'themeBlock') return $head.before(d);
  return null;
}
