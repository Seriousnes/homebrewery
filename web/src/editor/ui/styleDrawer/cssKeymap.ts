// Keys of the Style drawer's CSS editor, ported from legacy customKeyMaps.js:
//   cssKeymap      Mod-Shift-F and Alt-Shift-F format the CSS (or the selection) with Prettier
//                  (customKeyMaps.js:244-247).
//   generalKeymap  the parts of legacy's generalKeymap (:235-242) that apply to CSS: Tab inserts a
//                  tab or indents the selected lines, Shift-Tab outdents, Mod-Y redoes as well as
//                  Mod-Shift-Z, and Mod-D deletes the line (users asked for it upstream).
// CodeMirror leaves the editor on Escape followed by Tab (tab-focus mode), so Tab doesn't trap
// keyboard users.
import { deleteLine, indentLess, insertTab, redo, undo } from '@codemirror/commands';
import { Prec, type Extension } from '@codemirror/state';
import { keymap, type Command } from '@codemirror/view';

/** Mod-Shift-F / Alt-Shift-F → `format` (highest precedence, as legacy). */
export function cssKeymap(format: Command): Extension {
  return Prec.highest(
    keymap.of([
      { key: 'Mod-Shift-f', run: format, preventDefault: true },
      { key: 'Alt-Shift-f', run: format, preventDefault: true },
    ]),
  );
}

export const generalKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Tab', run: insertTab, shift: indentLess },
    { key: 'Mod-z', run: undo, preventDefault: true },
    { key: 'Mod-Shift-z', run: redo, preventDefault: true },
    { key: 'Mod-y', run: redo, preventDefault: true },
    { key: 'Mod-d', run: deleteLine, preventDefault: true },
  ]),
);
