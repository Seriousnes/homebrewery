// Native replacements for snippets (plan §6.3; see native.ts). Each builds one transaction
// (one undo step, history closed before it) from an editor state. Section settings and page
// breaks use the pagination-UX lane's section commands (commands/sections.ts): a setting lives
// on the section's first page and the section sync copies it to the section's auto pages.
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import type { Command, EditorState, Transaction } from '@tiptap/pm/state';
import { insertPageBreak, setSectionAttrs as setSectionAttrsCommand } from '../commands/sections';
import { pageIndexAt } from '../pagination/boundary';
import type { NativeSnippetAction } from './native';
import { FOOTER_PLACEHOLDER } from './shims/footer.gen';
import { insertFragment } from './insertSnippet';
import { addPageMarkers } from './sections';

/** The toc node the Insert menu adds: every level, so the theme's --TOC rules decide (as upstream). */
export const INSERTED_TOC_ATTRS = { depth: 6, wide: true, title: 'Contents' } as const;

/** The transaction a ProseMirror command would dispatch (history closed before it), or null. */
function capture(state: EditorState, command: Command): Transaction | null {
  let captured: Transaction | null = null;
  const ok = command(state, (tr) => {
    captured = tr;
  });
  const tr = captured as Transaction | null;
  return ok && tr && tr.docChanged ? closeHistory(tr) : null;
}

/** Inserts a live table of contents at the selection. */
export function insertTocTr(state: EditorState, attrs: Partial<{ depth: number; wide: boolean; title: string }> = {}): Transaction | null {
  const type = state.schema.nodes.toc;
  if (!type) return null;
  const tr = state.tr;
  if (!insertFragment(tr, Fragment.from(type.create({ ...INSERTED_TOC_ATTRS, ...attrs })))) return null;
  return closeHistory(tr).scrollIntoView();
}

/**
 * The text of the last heading of `level` before `pos` (in document order), or the upstream
 * placeholder "PART 1 | SECTION NAME" (footer.gen.js).
 */
export function footerTextBefore(doc: PMNode, pos: number, level: number): string {
  let text: string | null = null;
  doc.nodesBetween(0, Math.max(0, Math.min(pos, doc.content.size)), (node, nodePos) => {
    if (node.type.name === 'heading') {
      if (nodePos < pos && node.attrs.level === level) {
        const t = node.textContent.trim();
        if (t) text = t;
      }
      return false;
    }
    return !node.isTextblock;
  });
  return text ?? FOOTER_PLACEHOLDER;
}

/** Sets the section footer from the last heading of `level` before the cursor. */
export function footerFromHeadingTr(state: EditorState, level: number): Transaction | null {
  const footer = footerTextBefore(state.doc, state.selection.head, level);
  return capture(state, setSectionAttrsCommand({ footer }));
}

/** Turns on page numbers for the current section. */
export function pageNumberTr(state: EditorState): Transaction | null {
  return capture(state, setSectionAttrsCommand({ pageNumber: true }));
}

/**
 * Adds skipCounting / resetCounting to the current page (the head's; with everything selected, or
 * a node selection of the last page, the head is after the last page: that page).
 */
export function pageMarkerTr(state: EditorState, marker: 'skipCounting' | 'resetCounting'): Transaction | null {
  const tr = state.tr;
  if (!addPageMarkers(tr, pageIndexAt(tr.doc, tr.selection.head), [marker])) return null;
  return closeHistory(tr);
}

/** A manual page break at the cursor (upstream's page line): insertPageBreak, as Mod-Enter. */
export function pageBreakTr(state: EditorState): Transaction | null {
  return capture(state, insertPageBreak);
}

/** The transaction for a native snippet action (null when there is nothing to change). */
export function nativeActionTr(state: EditorState, action: NativeSnippetAction): Transaction | null {
  switch (action.kind) {
    case 'toc':
      return insertTocTr(state);
    case 'footer':
      return footerFromHeadingTr(state, action.level);
    case 'pageNumber':
      return pageNumberTr(state);
    case 'marker':
      return pageMarkerTr(state, action.marker);
    case 'pageBreak':
      return pageBreakTr(state);
  }
}
