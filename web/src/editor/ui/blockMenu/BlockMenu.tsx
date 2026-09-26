// BlockMenu (P5.3, P5.7): one menu button for the toolbar lane to slot in. It inserts and
// removes definition lists, spacers, column breaks and horizontal rules, inserts page breaks,
// sets the page's cover type, adds image and text objects, lists the page's objects (keyboard
// access to objects hidden behind text), and holds the actions for a selected inline image
// ('Place freely') or page object. Every action is one undo step.
//
//   <BlockMenu editor={editor} />
import type { Editor } from '@tiptap/core';
import type { Command } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { useState } from 'react';
import { MenuButton, type MenuEntry, type MenuLeaf } from '@/ui';
import { insertPageBreak } from '../../commands/sections';
import { addObject, DEFAULT_PLACEMENT, moveObjectInZOrder, placeImageFreely, selectObject, setPageCover } from '../../objects/commands';
import { imagePlacement } from '../../objects/dom';
import { objectLayerOf } from '../../objects/extension';
import { COVER_LABELS, COVER_MARKERS, imageObject, textObject, type CoverMarker } from '../../objects/model';
import { AddImageObjectDialog } from '../objects/AddImageObjectDialog';
import {
  BLOCK_LABELS,
  insertColumnBreak,
  insertDefinitionList,
  insertHorizontalRule,
  insertSpacer,
  removeBlock,
  runBlockCommand,
  type BlockTypeName,
} from './blockCommands';
import { blockMenuContext, type BlockMenuContext } from './blockMenuContext';

export interface BlockMenuProps {
  editor: Editor | null;
  /** Button text (default "Blocks"). */
  label?: string;
  /** Show only the icon (the label becomes its name). */
  iconOnly?: boolean;
  'data-testid'?: string;
}

const INSERT: Record<BlockTypeName, Command> = {
  definitionList: insertDefinitionList,
  spacer: insertSpacer,
  columnBreak: insertColumnBreak,
  horizontalRule: insertHorizontalRule,
};

const INSERT_ICONS = { definitionList: 'outline', spacer: 'plus', columnBreak: 'columnBreak', horizontalRule: 'minus' } as const;

/** Runs a command, then puts the focus on the selected object's frame. */
function runOnObject(editor: Editor, command: Command): void {
  command(editor.state, editor.view.dispatch, editor.view);
  objectLayerOf(editor)?.focusFrame();
}

function items(editor: Editor, ctx: BlockMenuContext, openImageDialog: () => void): MenuEntry[] {
  const insert: MenuLeaf[] = (Object.keys(INSERT) as BlockTypeName[]).map((type) => ({
    id: `insert-${type}`,
    label: BLOCK_LABELS[type],
    icon: INSERT_ICONS[type],
    disabled: !ctx.canInsert[type],
    onSelect: () => runBlockCommand(editor, INSERT[type]),
  }));
  insert.push({
    id: 'insert-pageBreak',
    label: 'Page break (new section)',
    icon: 'pageBreak',
    shortcut: 'Ctrl+Enter',
    disabled: !ctx.canInsert.pageBreak,
    onSelect: () => runBlockCommand(editor, insertPageBreak),
  });
  const entries: MenuEntry[] = [{ type: 'group', id: 'insert', label: 'Insert', items: insert }];

  if (ctx.removable.length) {
    entries.push({
      type: 'group',
      id: 'remove',
      label: 'Remove',
      items: ctx.removable.map((type) => ({
        id: `remove-${type}`,
        label: type === 'definitionList' ? 'Remove definition list (keep its text)' : `Remove ${BLOCK_LABELS[type].toLowerCase()}`,
        icon: 'trash',
        onSelect: () => runBlockCommand(editor, removeBlock(type)),
      })),
    });
  }

  if (ctx.imagePos !== null && ctx.pagePos !== null) {
    const imagePos = ctx.imagePos;
    const pagePos = ctx.pagePos;
    entries.push({
      type: 'group',
      id: 'image',
      label: 'Image',
      items: [
        {
          id: 'place-freely',
          label: 'Place freely (on the page)',
          icon: 'image',
          onSelect: () => {
            const at = imagePlacement(editor, imagePos, pagePos) ?? { ...DEFAULT_PLACEMENT };
            runOnObject(editor, placeImageFreely(imagePos, at));
          },
        },
      ],
    });
  }

  if (ctx.selected) {
    const sel = ctx.selected;
    const ref = { pagePos: sel.pagePos, id: sel.id };
    const objectItems: MenuLeaf[] = [];
    if (sel.kind === 'text') {
      objectItems.push({
        id: 'object-edit',
        label: 'Edit text',
        icon: 'paragraph',
        shortcut: 'Enter',
        onSelect: () => {
          const layer = objectLayerOf(editor);
          layer?.focusFrame();
          layer?.startEditing();
        },
      });
    } else {
      objectItems.push({ id: 'object-unplace', label: 'Put back in text', icon: 'image', onSelect: () => objectLayerOf(editor)?.putBackInText() });
    }
    objectItems.push(
      { id: 'object-forward', label: 'Bring forward', icon: 'chevronUp', shortcut: 'Ctrl+]', disabled: sel.index >= sel.count - 1, onSelect: () => runOnObject(editor, moveObjectInZOrder(ref, 'forward')) },
      { id: 'object-backward', label: 'Send backward', icon: 'chevronDown', shortcut: 'Ctrl+[', disabled: sel.index <= 0, onSelect: () => runOnObject(editor, moveObjectInZOrder(ref, 'backward')) },
      { id: 'object-delete', label: 'Delete object', icon: 'trash', shortcut: 'Delete', onSelect: () => objectLayerOf(editor)?.deleteSelected() },
    );
    entries.push({ type: 'group', id: 'object', label: sel.label, items: objectItems });
  }

  if (ctx.pagePos !== null) {
    const pagePos = ctx.pagePos;
    const cover = (value: CoverMarker | null): MenuLeaf => ({
      id: `cover-${value ?? 'none'}`,
      type: 'radio',
      label: value ? COVER_LABELS[value] : 'Not a cover page',
      checked: ctx.cover === value,
      onSelect: () => runBlockCommand(editor, setPageCover(pagePos, value)),
    });
    const pageItems: MenuLeaf[] = [cover(null), ...COVER_MARKERS.map(cover), { type: 'separator', id: 'page-sep' }];
    pageItems.push(
      { id: 'add-image-object', label: 'Add image object…', icon: 'image', onSelect: openImageDialog },
      {
        id: 'add-text-object',
        label: 'Add text object',
        icon: 'paragraph',
        onSelect: () => {
          const added = addObject(pagePos, (id) => textObject(id, 'Text', DEFAULT_PLACEMENT))(editor.state, editor.view.dispatch);
          const layer = objectLayerOf(editor);
          if (added && layer) {
            layer.focusFrame();
            layer.startEditing();
          }
        },
      },
    );
    for (const o of ctx.objects) {
      pageItems.push({
        id: `select-object-${o.id}`,
        label: `Select ${o.label}`,
        onSelect: () => runOnObject(editor, selectObject({ pagePos, id: o.id })),
      });
    }
    entries.push({ type: 'group', id: 'page', label: ctx.pageNumber ? `Page ${ctx.pageNumber}` : 'Page', items: pageItems });
  }
  return entries;
}

export function BlockMenu({ editor, label = 'Blocks', iconOnly = false, 'data-testid': testId = 'block-menu' }: BlockMenuProps) {
  // The menu's context (what can be inserted or removed at the caret, the page's objects) is
  // computed only while the menu is open: working it out after every transaction (every keystroke)
  // cost a fraction of a millisecond per key on a long brew, for a menu nobody had open (P8.1).
  const [menuOpen, setMenuOpen] = useState(false);
  const editable = useEditorState({ editor, selector: ({ editor: e }) => !!e && !e.isDestroyed && e.isEditable });
  const ctx = useEditorState({
    editor,
    selector: ({ editor: e }) => (menuOpen && e && !e.isDestroyed && e.isEditable ? blockMenuContext(e.state) : null),
  });
  const [imageDialog, setImageDialog] = useState(false);
  const [imagePage, setImagePage] = useState<number | null>(null);
  const entries = editor && ctx ? items(editor, ctx, () => {
    setImagePage(ctx.pagePos);
    setImageDialog(true);
  }) : [];

  return (
    <>
      <MenuButton label={label} icon="insert" iconOnly={iconOnly} items={entries} disabled={!editable} onOpenChange={setMenuOpen} data-testid={testId} />
      <AddImageObjectDialog
        open={imageDialog}
        onOpenChange={setImageDialog}
        onSubmit={(src) => {
          if (!editor || editor.isDestroyed || imagePage === null) return;
          addObject(imagePage, (id) => imageObject(id, src, { ...DEFAULT_PLACEMENT, width: 300 }))(editor.state, editor.view.dispatch);
          // After the dialog has returned the focus to the menu button.
          requestAnimationFrame(() => objectLayerOf(editor)?.focusFrame());
        }}
      />
    </>
  );
}
