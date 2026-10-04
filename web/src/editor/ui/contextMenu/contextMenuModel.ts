// What the context menu offers (plain data from the editor state, so it is unit-tested without a
// DOM), and the menu entries built from it. Inapplicable items are disabled, not hidden, so the
// menu keeps its shape; shortcuts are shown as hints. Every action is one undo step.
//
//   Cut · Copy · Paste · Paste as plain text
//   Format ▸ (marks) · Link… · Span with classes… · Text style ▸ · Table ▸
//   Insert ▸ (snippet…, table…, page break, column break, definition list, spacer, rule)
//   Columns ▸ (this section: 1, 2, theme default; every page: the same)
//   <block> group: Wrap in theme block… · Unwrap theme block · Properties… · Delete <block>
//   Delete blank page (the cursor's page, when its flow is empty)
//   Edit source…
import { isMarkActive, type Editor } from '@tiptap/core';
import { type Node as PMNode } from '@tiptap/pm/model';
import { type Command, type EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection, isInTable } from '@tiptap/pm/tables';
import type { MenuEntry, MenuLeaf } from '@/ui';
import { blockKindOf, themeBlockAt, unwrapThemeBlock } from '../../commands/blocks';
import { editorActions, emitKeymapRequest, runCommand, shortcutFor, shortcutLabel, type ShortcutId } from '../../commands/keymap';
import { inRichText, linkTarget, spanTarget } from '../../commands/marks';
import { deleteEmptyPage, insertPageBreak } from '../../commands/sections';
import { fragmentChain } from '../../pagination/fragments';
import { BLOCK_LABELS, insertColumnBreak, insertDefinitionList, insertHorizontalRule, insertSpacer, type BlockTypeName } from '../blockMenu/blockCommands';
import { typeLabel } from '../inspector/model';
import { tableMenuContext } from '../tableMenu/tableMenuContext';
import { CLIPBOARD_KEYS, type ClipboardAction } from './clipboard';

export const CONTEXT_MARKS = ['bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'code'] as const;
export type ContextMark = (typeof CONTEXT_MARKS)[number];

const MARK_LABELS: Record<ContextMark, string> = {
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  strike: 'Strikethrough',
  superscript: 'Superscript',
  subscript: 'Subscript',
  code: 'Inline code',
};

/** The block the Block group acts on. */
export interface BlockTarget {
  pos: number;
  type: string;
  /** "Theme block", "Paragraph", "Heading 2" … */
  label: string;
}

export interface ContextMenuContext {
  /** 'caret': empty text selection; 'text': a text range; 'node': a selected node; 'cells': table cells. */
  selection: 'caret' | 'text' | 'node' | 'cells';
  /** The selection is in text that takes marks (not a code block). */
  inText: boolean;
  marks: Record<ContextMark, boolean>;
  link: boolean;
  span: boolean;
  blockKind: ReturnType<typeof blockKindOf>;
  inTable: boolean;
  canInsert: Record<BlockTypeName | 'pageBreak' | 'table', boolean>;
  /** The innermost theme block's classes, or null outside one. */
  themeBlock: string[] | null;
  canUnwrap: boolean;
  block: BlockTarget | null;
  /** The cursor's page is blank (its flow one empty paragraph) and not the only page. */
  canDeletePage: boolean;
}

/**
 * The block at the selection: a selected block node, else the innermost theme block, else the
 * page-level block (a paragraph, a list, a table …).
 */
export function blockTarget(state: EditorState): { pos: number; node: PMNode } | null {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.isBlock && sel.node.type.name !== 'page') return { pos: sel.from, node: sel.node };
  const theme = themeBlockAt(state);
  if (theme) return { pos: theme.pos, node: theme.node };
  const $from = sel.$from;
  if ($from.depth < 2) {
    // Between blocks (a gap cursor): the block after it.
    const after = $from.depth === 1 ? $from.nodeAfter : null;
    return after ? { pos: $from.pos, node: after } : null;
  }
  return { pos: $from.before(2), node: $from.node(2) };
}

/**
 * Deletes the block blockTarget finds, with every fragment pagination split off it (the author's
 * one block). A page (or theme block) left without content keeps an empty paragraph.
 */
export const deleteBlock: Command = (state, dispatch) => {
  const target = blockTarget(state);
  if (!target) return false;
  const chain = fragmentChain(state.doc, target.pos);
  if (!dispatch) return true;
  const tr = state.tr;
  for (const pos of [...chain].reverse()) {
    const node = tr.doc.nodeAt(pos);
    if (!node) continue;
    const $pos = tr.doc.resolve(pos);
    if ($pos.parent.childCount === 1) {
      const filler = $pos.parent.type.contentMatch.defaultType?.createAndFill();
      if (!filler) return false;
      tr.replaceWith(pos, pos + node.nodeSize, filler);
    } else {
      tr.delete(pos, pos + node.nodeSize);
    }
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(chain[0]!, tr.doc.content.size))));
  dispatch(tr.scrollIntoView());
  return true;
};

export function contextMenuContext(state: EditorState): ContextMenuContext {
  const sel = state.selection;
  const kind: ContextMenuContext['selection'] =
    sel instanceof CellSelection ? 'cells' : sel instanceof NodeSelection ? 'node' : sel.empty ? 'caret' : 'text';
  const inText = inRichText(state);
  const marks = {} as Record<ContextMark, boolean>;
  for (const mark of CONTEXT_MARKS) marks[mark] = inText && Boolean(state.schema.marks[mark]) && isMarkActive(state, mark);
  const theme = themeBlockAt(state);
  const target = blockTarget(state);
  return {
    selection: kind,
    inText,
    marks,
    link: linkTarget(state) !== null,
    span: spanTarget(state) !== null,
    blockKind: blockKindOf(state),
    inTable: isInTable(state),
    canInsert: {
      definitionList: insertDefinitionList(state),
      spacer: insertSpacer(state),
      columnBreak: insertColumnBreak(state),
      horizontalRule: insertHorizontalRule(state),
      pageBreak: insertPageBreak(state),
      table: tableMenuContext(state).canInsertTable,
    },
    themeBlock: theme ? [...(theme.node.attrs.classes as string[])] : null,
    canUnwrap: unwrapThemeBlock(state),
    block: target ? { pos: target.pos, type: target.node.type.name, label: typeLabel(target.node.type.name, target.node.attrs) } : null,
    canDeletePage: deleteEmptyPage()(state),
  };
}

/** What the menu needs from its host besides the editor. */
export interface ContextMenuDeps {
  clipboard: (action: ClipboardAction) => void;
  /** Open the inspector on the block (ContextMenuHost: the UI store's inspector panel). */
  properties: () => void;
  /** The Text style submenu's entries (text-styles' textStyleEntries). */
  textStyles: readonly MenuEntry[];
  /** The Columns submenu's entries (columnsEntries). */
  columns?: readonly MenuEntry[];
  /** The Table submenu's entries (tables' tableMenuEntries), shown inside a table. */
  table?: readonly MenuEntry[];
}

const INSERT_BLOCKS: Record<BlockTypeName, Command> = {
  definitionList: insertDefinitionList,
  spacer: insertSpacer,
  columnBreak: insertColumnBreak,
  horizontalRule: insertHorizontalRule,
};

const hint = (id: ShortcutId) => shortcutFor(id).label;

/** The context menu's entries for `ctx` (see the top of the file). */
export function contextMenuEntries(editor: Editor, ctx: ContextMenuContext, deps: ContextMenuDeps): MenuEntry[] {
  const hasRange = ctx.selection !== 'caret';
  const clip = (id: ClipboardAction, label: string, disabled: boolean): MenuLeaf => ({
    id,
    label,
    shortcut: shortcutLabel(CLIPBOARD_KEYS[id]),
    disabled,
    onSelect: () => deps.clipboard(id),
  });

  const format: MenuEntry[] = CONTEXT_MARKS.map((mark) => ({
    id: `mark-${mark}`,
    type: 'checkbox' as const,
    label: MARK_LABELS[mark],
    shortcut: hint(mark),
    checked: ctx.marks[mark],
    disabled: !ctx.inText,
    onCheckedChange: () => editorActions[mark](editor),
  }));

  const insert: MenuEntry[] = [
    { id: 'insert-snippet', label: 'Snippet…', onSelect: () => emitKeymapRequest(editor, 'insertSnippet') },
    { id: 'insert-table', label: 'Table…', disabled: !ctx.canInsert.table, onSelect: () => emitKeymapRequest(editor, 'insertTable') },
    { type: 'separator', id: 'insert-sep-breaks' },
    { id: 'insert-pageBreak', label: 'Page break (new section)', shortcut: hint('pageBreak'), disabled: !ctx.canInsert.pageBreak, onSelect: () => editorActions.pageBreak(editor) },
    { id: 'insert-columnBreak', label: 'Column break', shortcut: hint('columnBreak'), disabled: !ctx.canInsert.columnBreak, onSelect: () => editorActions.columnBreak(editor) },
    { type: 'separator', id: 'insert-sep-blocks' },
    ...(['definitionList', 'spacer', 'horizontalRule'] as const).map(
      (type): MenuLeaf => ({
        id: `insert-${type}`,
        label: BLOCK_LABELS[type],
        disabled: !ctx.canInsert[type],
        onSelect: () => runCommand(editor, INSERT_BLOCKS[type]),
      }),
    ),
  ];

  const block = ctx.block;
  const blockItems: MenuLeaf[] = [
    { id: 'block-wrap', label: 'Wrap in theme block…', shortcut: hint('themeBlock'), onSelect: () => emitKeymapRequest(editor, 'themeBlock') },
    { id: 'block-unwrap', label: 'Unwrap theme block', disabled: !ctx.canUnwrap, onSelect: () => editorActions.unwrapThemeBlock(editor) },
    { id: 'block-properties', label: 'Properties…', icon: 'settings', disabled: !block, onSelect: deps.properties },
    {
      id: 'block-delete',
      label: block ? `Delete ${block.label.toLowerCase()}` : 'Delete block',
      icon: 'trash',
      disabled: !block,
      onSelect: () => runCommand(editor, deleteBlock),
    },
  ];

  return [
    clip('cut', 'Cut', !hasRange),
    clip('copy', 'Copy', !hasRange),
    clip('paste', 'Paste', false),
    clip('pastePlain', 'Paste as plain text', false),
    { type: 'separator', id: 'sep-clipboard' },
    { type: 'submenu', id: 'format', label: 'Format', icon: 'bold', disabled: !ctx.inText, items: format },
    { id: 'link', label: ctx.link ? 'Edit link…' : 'Link…', icon: 'link', shortcut: hint('link'), disabled: !ctx.inText, onSelect: () => emitKeymapRequest(editor, 'link') },
    {
      id: 'span',
      label: ctx.span ? 'Edit span classes…' : 'Span with classes…',
      icon: 'braces',
      shortcut: hint('span'),
      disabled: !ctx.inText,
      onSelect: () => emitKeymapRequest(editor, 'span'),
    },
    { type: 'submenu', id: 'text-style', label: 'Text style', icon: 'paragraph', disabled: ctx.blockKind === null, items: deps.textStyles },
    { type: 'submenu', id: 'table', label: 'Table', icon: 'table', disabled: !ctx.inTable || !deps.table?.length, items: deps.table ?? [] },
    { type: 'separator', id: 'sep-format' },
    { type: 'submenu', id: 'insert', label: 'Insert', icon: 'insert', items: insert },
    { type: 'submenu', id: 'columns', label: 'Columns', icon: 'columns', disabled: !deps.columns?.length, items: deps.columns ?? [] },
    { type: 'group', id: 'block', label: block?.label ?? 'Block', items: blockItems },
    { id: 'page-delete', label: 'Delete blank page', icon: 'trash', disabled: !ctx.canDeletePage, onSelect: () => runCommand(editor, deleteEmptyPage()) },
    { type: 'separator', id: 'sep-block' },
    { id: 'edit-source', label: 'Edit source…', icon: 'code', shortcut: hint('editSource'), onSelect: () => emitKeymapRequest(editor, 'editSource') },
  ];
}
