// Cut, Copy, Paste and Paste as plain text for the context menu, with exactly what Ctrl+X / C / V
// / Shift+V do:
//
//   copy, cut      the selection serialized by the view (view.serializeForClipboard: the schema's
//                  DOM, ProseMirror's data-pm-slice and pasteCleanup's CLIPBOARD_ATTR, from the
//                  clipboardSerializer prop), written as text/html + text/plain with the async
//                  Clipboard API. Where that is missing or refused, document.execCommand runs the
//                  editor's own copy/cut handler. Cut then deletes the selection (uiEvent 'cut').
//   paste          the clipboard read with the async Clipboard API and fed to view.pasteHTML /
//                  pasteText: the editor's paste pipeline (transformPastedHTML = pasteCleanup,
//                  handlePaste props, plain-text parsing).
//
// Pages can't read the clipboard without the browser's permission. A refused or unsupported
// read shows a toast that explains the keyboard shortcut instead. Every change is its own undo step.
import type { Editor } from '@tiptap/core';
import { toast } from '@/ui';
import { closeUndoGroup, isMacPlatform, shortcutLabel } from '../../commands/keymap';

export type ClipboardAction = 'cut' | 'copy' | 'paste' | 'pastePlain';

/** The keys that do the same (ProseMirror key names). */
export const CLIPBOARD_KEYS: Readonly<Record<ClipboardAction, string>> = { cut: 'Mod-x', copy: 'Mod-c', paste: 'Mod-v', pastePlain: 'Shift-Mod-v' };

const VERBS: Readonly<Record<ClipboardAction, string>> = { cut: 'cut', copy: 'copy', paste: 'paste', pastePlain: 'paste as plain text' };

/** What the toast says when the browser refuses an action. */
export function blockedMessage(action: ClipboardAction, mac = isMacPlatform()): { title: string; description: string } {
  const reading = action === 'paste' || action === 'pastePlain';
  return {
    title: reading ? 'The browser didn’t allow reading the clipboard' : 'The browser didn’t allow writing to the clipboard',
    description: `Press ${shortcutLabel(CLIPBOARD_KEYS[action], mac)} to ${VERBS[action]} instead.`,
  };
}

function reportBlocked(action: ClipboardAction): void {
  toast({ ...blockedMessage(action), tone: 'warning' });
}

/** Deletes the selection as a cut does (one undo step). */
function deleteSelection(editor: Editor): void {
  if (editor.isDestroyed || editor.state.selection.empty) return;
  closeUndoGroup(editor);
  editor.view.dispatch(editor.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
  closeUndoGroup(editor);
}

/** The editor's own copy/cut handler, through a native command (needs the page's user activation). */
function execClipboardCommand(editor: Editor, command: 'copy' | 'cut'): boolean {
  try {
    editor.view.focus();
    return editor.view.dom.ownerDocument.execCommand(command);
  } catch {
    return false;
  }
}

async function writeSelection(editor: Editor): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.write || typeof ClipboardItem === 'undefined') return false;
  const { dom, text } = editor.view.serializeForClipboard(editor.state.selection.content());
  try {
    await clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([dom.innerHTML], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Copy, or cut, the selection (see the top of the file). */
export async function copySelection(editor: Editor, cut: boolean): Promise<boolean> {
  if (editor.isDestroyed || editor.state.selection.empty) return false;
  if (await writeSelection(editor)) {
    if (cut) deleteSelection(editor);
    return true;
  }
  // The editor's own handler cuts too (and is its own undo step, as Ctrl+X).
  if (execClipboardCommand(editor, cut ? 'cut' : 'copy')) return true;
  reportBlocked(cut ? 'cut' : 'copy');
  return false;
}

async function readClipboard(plain: boolean): Promise<{ html: string | null; text: string } | null> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard) return null;
  try {
    if (!plain && clipboard.read) {
      let html: string | null = null;
      let text = '';
      for (const item of await clipboard.read()) {
        if (html === null && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
      return { html, text };
    }
    if (!clipboard.readText) return null;
    return { html: null, text: await clipboard.readText() };
  } catch {
    return null;
  }
}

/** A paste event carrying the clipboard, for the editor's handlePaste props. */
function pasteEvent(html: string | null, text: string): ClipboardEvent | undefined {
  try {
    const data = new DataTransfer();
    if (html !== null) data.setData('text/html', html);
    data.setData('text/plain', text);
    return new ClipboardEvent('paste', { clipboardData: data });
  } catch {
    return undefined;
  }
}

/** Paste the clipboard (as plain text with `plain`) at the selection (see the top of the file). */
export async function pasteClipboard(editor: Editor, plain: boolean): Promise<boolean> {
  const action: ClipboardAction = plain ? 'pastePlain' : 'paste';
  const content = await readClipboard(plain);
  if (!content) {
    reportBlocked(action);
    return false;
  }
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { view } = editor;
  const event = pasteEvent(plain ? null : content.html, content.text);
  closeUndoGroup(editor);
  const done = !plain && content.html ? view.pasteHTML(content.html, event) : view.pasteText(content.text, event);
  closeUndoGroup(editor);
  return done;
}
