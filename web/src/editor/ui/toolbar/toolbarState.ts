// What the toolbar shows, read from the editor state. The toolbar selects it with useEditorState
// (deep-equal), so transactions that don't change it, pagination's included, don't re-render.
import type { Editor } from '@tiptap/core';
import { redoDepth, undoDepth } from '@tiptap/pm/history';
import { alignOf, blockKindOf, inBlockquote, listKindOf, type ListKind, type TextStyleKind, type ThemeBoxClass, themeBoxesAt } from '../../commands/blocks';
import { inRichText } from '../../commands/marks';

export const TOOLBAR_MARKS = ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'code', 'link', 'span'] as const;
export type ToolbarMark = (typeof TOOLBAR_MARKS)[number];

/** 'default' = no align attribute (the theme decides); 'none' = no paragraph selected. */
export type ToolbarAlign = 'left' | 'center' | 'right' | 'justify' | 'default' | 'mixed' | 'none';

export interface ToolbarState {
  editable: boolean;
  /** The selection is in text where marks apply (not in a code block). */
  inText: boolean;
  blockKind: TextStyleKind | 'mixed' | 'other' | null;
  quote: boolean;
  /** The theme boxes (note, descriptive, quote) around the selection. */
  boxes: ThemeBoxClass[];
  marks: Record<ToolbarMark, boolean>;
  align: ToolbarAlign;
  list: ListKind | null;
  canUndo: boolean;
  canRedo: boolean;
}

export function toolbarStateOf(editor: Editor): ToolbarState {
  const state = editor.state;
  const editable = editor.isEditable;
  const marks = {} as Record<ToolbarMark, boolean>;
  for (const mark of TOOLBAR_MARKS) marks[mark] = state.schema.marks[mark] ? editor.isActive(mark) : false;
  const align = alignOf(state);
  return {
    editable,
    inText: inRichText(state),
    blockKind: blockKindOf(state),
    quote: inBlockquote(state),
    boxes: themeBoxesAt(state),
    marks,
    align: align === undefined ? 'none' : align === null ? 'default' : align,
    list: listKindOf(state),
    canUndo: editable && undoDepth(state) > 0,
    canRedo: editable && redoDepth(state) > 0,
  };
}
