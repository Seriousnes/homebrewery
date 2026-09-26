// Icon editing (P5.5): `:` autocomplete with its suggestion list, and the insertIcon command the
// icon picker uses.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type Command } from '@tiptap/pm/state';
import { IconSuggestionPopup } from '../ui/iconPicker/suggestionPopup';
import type { IconEntry } from './catalog';
import { iconSuggestionPlugin } from './suggestion';

/** Inserts an icon at the selection (replacing selected text); one undo step. */
export function insertIcon(icon: Pick<IconEntry, 'font' | 'glyph'>): Command {
  return (state, dispatch) => {
    const type = state.schema.nodes.icon;
    if (!type) return false;
    const { $from } = state.selection;
    if (!$from.parent.inlineContent || !$from.parent.type.contentMatch.matchType(type) || $from.parent.type.spec.code) return false;
    if (dispatch) dispatch(state.tr.replaceSelectionWith(type.create({ font: icon.font, glyph: icon.glyph }), true).scrollIntoView());
    return true;
  };
}

const popupKey = new PluginKey('hbIconSuggestionPopup');

/** `:` autocomplete for icons; add it to an editing canvas's extensions. */
export const IconSuggestion = Extension.create({
  name: 'hbIconSuggestion',
  // Before the keymaps that also want ArrowUp/Down, Enter and Tab: column navigation (1000) and
  // HbKeymap (1200), whose Tab sinks a list item (review finding UI-5). Its keys act only while
  // the list is open.
  priority: 1300,
  addProseMirrorPlugins() {
    return [iconSuggestionPlugin(), new Plugin({ key: popupKey, view: (view) => new IconSuggestionPopup(view) })];
  },
});
