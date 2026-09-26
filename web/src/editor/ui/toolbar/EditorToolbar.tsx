import type { Editor } from '@tiptap/core';
import clsx from 'clsx';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef } from 'react';
import { type Spread, uiStore, useUiStore, ZOOM_LEVELS } from '@/app/uiStore';
import { IconButton, type IconName, type MenuEntry, MenuButton, Toolbar, ToolbarGroup, ToolbarSeparator } from '@/ui';
import { type AlignValue, TEXT_BLOCK_KINDS, TEXT_BLOCK_LABELS, type TextBlockKind } from '../../commands/blocks';
import { editorActions, emitKeymapRequest, onKeymapRequest, shortcutFor, type ShortcutId } from '../../commands/keymap';
import { EditorDialogs } from './EditorDialogs';
import styles from './EditorToolbar.module.css';
import type { ToolbarMark } from './toolbarState';
import { useToolbarState } from './useToolbarState';

export interface EditorToolbarProps {
  editor: Editor;
  /** The Insert menu (snippets lane's InsertMenu), shown in the Insert group. */
  insertMenu?: ReactNode;
  /** Save status (autosave lane), shown at the end. */
  status?: ReactNode;
  /** The toolbar's accessible name (default "Editing"). */
  label?: string;
  /** Render the class picker and link dialog host (default true). */
  dialogs?: boolean;
  className?: string;
  'data-testid'?: string;
}

const MARK_BUTTONS: readonly { mark: Exclude<ToolbarMark, 'link' | 'span'>; icon: IconName; label: string }[] = [
  { mark: 'bold', icon: 'bold', label: 'Bold' },
  { mark: 'italic', icon: 'italic', label: 'Italic' },
  { mark: 'underline', icon: 'underline', label: 'Underline' },
  { mark: 'strike', icon: 'strike', label: 'Strikethrough' },
  { mark: 'superscript', icon: 'superscript', label: 'Superscript' },
  { mark: 'subscript', icon: 'subscript', label: 'Subscript' },
  { mark: 'code', icon: 'code', label: 'Inline code' },
];

const ALIGN_BUTTONS: readonly { value: Exclude<AlignValue, null>; icon: IconName; label: string }[] = [
  { value: 'left', icon: 'alignLeft', label: 'Align left' },
  { value: 'center', icon: 'alignCenter', label: 'Center' },
  { value: 'right', icon: 'alignRight', label: 'Align right' },
  { value: 'justify', icon: 'alignJustify', label: 'Justify' },
];

const KIND_ICONS: Record<TextBlockKind, IconName> = {
  paragraph: 'paragraph',
  heading1: 'heading1',
  heading2: 'heading2',
  heading3: 'heading3',
  heading4: 'heading',
  heading5: 'heading',
  heading6: 'heading',
  codeBlock: 'code',
};

const KIND_SHORTCUTS: Record<TextBlockKind, ShortcutId> = {
  paragraph: 'paragraph',
  heading1: 'heading1',
  heading2: 'heading2',
  heading3: 'heading3',
  heading4: 'heading4',
  heading5: 'heading5',
  heading6: 'heading6',
  codeBlock: 'codeBlock',
};

const SPREAD_LABELS: Record<Spread, string> = { single: 'Single pages', facing: 'Facing pages', flow: 'Flowing pages' };
const SPREAD_ICONS: Record<Spread, IconName> = { single: 'spreadSingle', facing: 'spreadFacing', flow: 'spreadFlow' };

const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;

/**
 * The editor toolbar (plan §6.2): block type, marks, span classes and theme blocks, alignment,
 * lists, the Insert menu slot, page and column breaks, undo and redo, zoom and spread (UI store),
 * and the save status slot. One tab stop with roving focus (UI kit Toolbar); Alt+F10 in the
 * editor focuses it, Escape goes back to the editor. Buttons never take the focus from the
 * editor on click, so the selection stays visible. Commands are one undo step each.
 */
export function EditorToolbar({ editor, insertMenu, status, label = 'Editing', dialogs = true, className, 'data-testid': testId }: EditorToolbarProps) {
  const state = useToolbarState(editor);
  const zoom = useUiStore((s) => s.zoom);
  const spread = useUiStore((s) => s.spread);
  const rootRef = useRef<HTMLDivElement>(null);

  // Alt+F10 in the editor: focus the toolbar's current item.
  useEffect(
    () =>
      onKeymapRequest(editor, (request) => {
        if (request !== 'focusToolbar') return false;
        const root = rootRef.current;
        const item = root?.querySelector<HTMLElement>('[tabindex="0"]') ?? root?.querySelector<HTMLElement>('button:not(:disabled)');
        if (!item) return false;
        item.focus();
        return true;
      }),
    [editor],
  );

  const focusEditor = () => {
    if (!editor.isDestroyed) editor.view.focus();
  };
  const disabled = !state.editable;
  const tip = (id: ShortcutId) => {
    const s = shortcutFor(id);
    return { shortcut: s.label, 'aria-keyshortcuts': s.aria };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!rootRef.current?.contains(event.target as Node)) return; // a portaled menu or dialog
    event.preventDefault();
    focusEditor();
  };
  // Clicking a button keeps the focus (and the visible selection) in the editor.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button')) event.preventDefault();
  };

  const blockLabel =
    state.blockKind === null ? 'Block' : state.blockKind === 'mixed' ? 'Mixed' : state.blockKind === 'other' ? 'Definition' : TEXT_BLOCK_LABELS[state.blockKind];
  const blockItems: MenuEntry[] = [
    {
      type: 'group',
      id: 'text-style',
      label: 'Text style',
      items: TEXT_BLOCK_KINDS.map((kind) => ({
        id: kind,
        type: 'radio' as const,
        label: TEXT_BLOCK_LABELS[kind],
        icon: KIND_ICONS[kind],
        shortcut: shortcutFor(KIND_SHORTCUTS[kind]).label,
        checked: state.blockKind === kind,
        onSelect: () => {
          editorActions.setBlockKind(editor, kind);
          focusEditor();
        },
      })),
    },
    { type: 'separator' },
    {
      id: 'blockquote',
      type: 'checkbox',
      label: 'Blockquote',
      icon: 'quote',
      shortcut: shortcutFor('blockquote').label,
      checked: state.quote,
      onCheckedChange: () => {
        editorActions.blockquote(editor);
        focusEditor();
      },
    },
  ];

  const classItems: MenuEntry[] = [
    {
      id: 'span',
      label: state.marks.span ? 'Edit span classes…' : 'Span with classes…',
      shortcut: shortcutFor('span').label,
      disabled: !state.inText,
      onSelect: () => emitKeymapRequest(editor, 'span'),
    },
    {
      id: 'themeBlock',
      label: 'Wrap in theme block…',
      shortcut: shortcutFor('themeBlock').label,
      onSelect: () => emitKeymapRequest(editor, 'themeBlock'),
    },
  ];

  const zoomItems: MenuEntry[] = ZOOM_LEVELS.map((level) => ({
    id: String(level),
    type: 'radio' as const,
    label: percent(level),
    checked: Math.abs(zoom - level) < 1e-6,
    onSelect: () => uiStore.getState().setZoom(level),
  }));
  const spreadItems: MenuEntry[] = (['single', 'facing', 'flow'] as const).map((id) => ({
    id,
    type: 'radio' as const,
    label: SPREAD_LABELS[id],
    icon: SPREAD_ICONS[id],
    checked: spread === id,
    onSelect: () => uiStore.getState().setSpread(id),
  }));

  const alignDisabled = disabled || state.align === 'none';

  return (
    <>
      <Toolbar
        ref={rootRef}
        label={label}
        className={clsx(styles.toolbar, className)}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        data-testid={testId}
      >
        <ToolbarGroup label="History">
          <IconButton icon="undo" label="Undo" tooltip="bottom" {...tip('undo')} disabled={!state.canUndo} onClick={() => editorActions.undo(editor)} />
          <IconButton icon="redo" label="Redo" tooltip="bottom" {...tip('redo')} disabled={!state.canRedo} onClick={() => editorActions.redo(editor)} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Block">
          <MenuButton
            label={blockLabel}
            aria-label={`Block type: ${blockLabel}`}
            menuLabel="Block type"
            items={blockItems}
            variant="ghost"
            disabled={disabled || state.blockKind === null}
            className={styles.blockType}
            data-testid="block-type"
          />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Text">
          {MARK_BUTTONS.map(({ mark, icon, label: markLabel }) => (
            <IconButton
              key={mark}
              icon={icon}
              label={markLabel}
              tooltip="bottom"
              {...tip(mark)}
              pressed={state.marks[mark]}
              disabled={disabled || !state.inText}
              onClick={() => editorActions[mark](editor)}
              data-testid={`mark-${mark}`}
            />
          ))}
          <IconButton
            icon="link"
            label={state.marks.link ? 'Edit link' : 'Link'}
            tooltip="bottom"
            {...tip('link')}
            pressed={state.marks.link}
            disabled={disabled || !state.inText}
            onClick={() => emitKeymapRequest(editor, 'link')}
            data-testid="mark-link"
          />
          <MenuButton
            label="Classes"
            icon="braces"
            iconOnly
            menuLabel="Classes"
            items={classItems}
            disabled={disabled}
            data-testid="classes-menu"
          />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Alignment">
          {ALIGN_BUTTONS.map(({ value, icon, label: alignLabel }) => (
            <IconButton
              key={value}
              icon={icon}
              label={alignLabel}
              tooltip="bottom"
              pressed={state.align === value}
              disabled={alignDisabled}
              onClick={() => editorActions.align(editor, state.align === value ? null : value)}
              data-testid={`align-${value}`}
            />
          ))}
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Lists">
          <IconButton
            icon="bulletList"
            label="Bulleted list"
            tooltip="bottom"
            {...tip('bulletList')}
            pressed={state.list === 'bulletList'}
            disabled={disabled}
            onClick={() => editorActions.bulletList(editor)}
            data-testid="list-bullet"
          />
          <IconButton
            icon="orderedList"
            label="Numbered list"
            tooltip="bottom"
            {...tip('orderedList')}
            pressed={state.list === 'orderedList'}
            disabled={disabled}
            onClick={() => editorActions.orderedList(editor)}
            data-testid="list-ordered"
          />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Insert">
          {insertMenu}
          <IconButton
            icon="pageBreak"
            label="Page break"
            tooltip="bottom"
            {...tip('pageBreak')}
            disabled={disabled}
            onClick={() => editorActions.pageBreak(editor)}
            data-testid="insert-page-break"
          />
          <IconButton
            icon="columnBreak"
            label="Column break"
            tooltip="bottom"
            {...tip('columnBreak')}
            disabled={disabled}
            onClick={() => editorActions.columnBreak(editor)}
            data-testid="insert-column-break"
          />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="View">
          <IconButton icon="zoomOut" label="Zoom out" tooltip="bottom" disabled={zoom <= ZOOM_LEVELS[0]!} onClick={() => uiStore.getState().zoomOut()} data-testid="zoom-out" />
          <MenuButton label={percent(zoom)} aria-label={`Zoom: ${percent(zoom)}`} menuLabel="Zoom" items={zoomItems} variant="ghost" className={styles.zoom} data-testid="zoom-menu" />
          <IconButton
            icon="zoomIn"
            label="Zoom in"
            tooltip="bottom"
            disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!}
            onClick={() => uiStore.getState().zoomIn()}
            data-testid="zoom-in"
          />
          <MenuButton label={`Page layout: ${SPREAD_LABELS[spread]}`} icon={SPREAD_ICONS[spread]} iconOnly menuLabel="Page layout" items={spreadItems} data-testid="spread-menu" />
        </ToolbarGroup>
        {status != null ? <div className={styles.status}>{status}</div> : null}
      </Toolbar>
      {dialogs ? <EditorDialogs editor={editor} /> : null}
    </>
  );
}
