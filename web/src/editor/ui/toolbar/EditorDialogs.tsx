import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';
import { toast } from '@/ui';
import { editorActions, onKeymapRequest } from '../../commands/keymap';
import { ClassPicker } from '../classPicker/ClassPicker';
import { LinkDialog } from '../linkDialog/LinkDialog';
import { describeDialog, type EditorDialogState, isDialogRequest } from './dialogState';

export interface EditorDialogsProps {
  editor: Editor;
}

/**
 * Opens the class picker (Mod-M, Shift-Mod-M) and the link dialog (Mod-K) for the keymap's and
 * the toolbar's requests, and applies the result as one undo step. EditorToolbar renders it; mount
 * it yourself only for an editor without the toolbar. Focus goes back where it was on close.
 */
export function EditorDialogs({ editor }: EditorDialogsProps) {
  const [dialog, setDialog] = useState<EditorDialogState | null>(null);

  useEffect(
    () =>
      onKeymapRequest(editor, (request) => {
        if (!isDialogRequest(request) || !editor.isEditable) return false;
        setDialog(describeDialog(editor, request));
        return true;
      }),
    [editor],
  );

  const onOpenChange = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const report = (ok: boolean, what: string) => {
    if (!ok) toast({ title: `Couldn’t ${what}`, description: 'The selection changed or can’t take it here.', tone: 'warning' });
  };

  if (dialog?.kind === 'link') {
    return (
      <LinkDialog
        open
        onOpenChange={onOpenChange}
        initialHref={dialog.href}
        editing={dialog.editing}
        askText={dialog.askText}
        onApply={(href, text) => report(editorActions.applyLink(editor, href, text), 'add the link')}
        onRemove={() => report(editorActions.removeLink(editor), 'remove the link')}
        data-testid="link-dialog"
      />
    );
  }
  if (dialog?.kind === 'span') {
    return (
      <ClassPicker
        open
        mode="span"
        onOpenChange={onOpenChange}
        initialClasses={dialog.classes}
        editing={dialog.editing}
        suggestions={dialog.suggestions}
        onApply={(classes) => report(editorActions.applySpan(editor, classes), 'apply the span')}
        onRemove={dialog.editing ? () => report(editorActions.removeSpan(editor), 'remove the span') : undefined}
        data-testid="class-picker"
      />
    );
  }
  if (dialog?.kind === 'themeBlock') {
    const enclosing = dialog.enclosing;
    return (
      <ClassPicker
        open
        mode="themeBlock"
        onOpenChange={onOpenChange}
        suggestions={dialog.suggestions}
        onApply={(classes) => report(editorActions.wrapInThemeBlock(editor, classes), 'wrap the selection')}
        onRemove={enclosing ? () => report(editorActions.unwrapThemeBlock(editor), 'unwrap the block') : undefined}
        removeLabel={enclosing ? `Unwrap ${enclosing.length ? `“${enclosing.join(' ')}”` : 'the enclosing block'}` : undefined}
        data-testid="class-picker"
      />
    );
  }
  return null;
}
