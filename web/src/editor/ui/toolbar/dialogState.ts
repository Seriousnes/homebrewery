// What the class picker and link dialog open with, read from the editor when a request comes in.
import type { Editor } from '@tiptap/core';
import { themeBlockAt } from '../../commands/blocks';
import type { KeymapRequest } from '../../commands/keymap';
import { linkTarget, spanTarget } from '../../commands/marks';
import { collectThemeClasses, type ThemeClass } from '../classPicker/themeClasses';

export type EditorDialogState =
  | { kind: 'span'; classes: string[]; editing: boolean; suggestions: ThemeClass[] }
  | { kind: 'themeBlock'; suggestions: ThemeClass[]; enclosing: string[] | null }
  | { kind: 'link'; href: string; editing: boolean; askText: boolean };

export type DialogRequest = Extract<KeymapRequest, 'span' | 'themeBlock' | 'link'>;

export const isDialogRequest = (request: KeymapRequest): request is DialogRequest =>
  request === 'span' || request === 'themeBlock' || request === 'link';

/** The dialog for a request, from the editor's current selection and the page's stylesheets. */
export function describeDialog(editor: Editor, request: DialogRequest): EditorDialogState {
  const state = editor.state;
  if (request === 'link') {
    const target = linkTarget(state);
    return { kind: 'link', href: target?.href ?? '', editing: target !== null, askText: target === null && state.selection.empty };
  }
  const suggestions = collectThemeClasses({ document: editor.view.dom.ownerDocument });
  if (request === 'span') {
    const target = spanTarget(state);
    return { kind: 'span', classes: target ? [...(target.mark.attrs.classes as string[])] : [], editing: target !== null, suggestions };
  }
  const enclosing = themeBlockAt(state);
  return { kind: 'themeBlock', suggestions, enclosing: enclosing ? [...(enclosing.node.attrs.classes as string[])] : null };
}
