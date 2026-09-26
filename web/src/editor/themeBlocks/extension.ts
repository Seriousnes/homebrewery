// The NodeView extensions of the snippets lane (P5.2, P5.4). Each is the schema extension
// extended with addNodeView (plus behaviour), never a schema change, so
// buildEditorExtensions({ extensions: [...] }) swaps it in place of the schema's node.
//
//   ThemeBlockWithView  themeBlock: ThemeBlockNodeView (element = contentDOM, attributes patched
//                       in place), the label overlay with Wide/Frame toggles, Shift+Alt+F10.
//   TocWithView         toc: TocView (live entries) and the refresher plugin.
import { ThemeBlock, Toc } from '../schema';
import { TocView } from '../nodeviews/TocView';
import { tocPlugin } from '../toc/tocPlugin';
import { focusThemeBlockControls, themeBlockOverlayPlugin } from './overlay';
import { ThemeBlockNodeView } from './ThemeBlockNodeView';

/** Moves the focus to the theme-block controls (ProseMirror key name). */
export const THEME_BLOCK_CONTROLS_KEY = 'Shift-Alt-F10';

export const ThemeBlockWithView = ThemeBlock.extend({
  addNodeView() {
    return ({ node }) => new ThemeBlockNodeView(node);
  },
  addProseMirrorPlugins() {
    return [themeBlockOverlayPlugin()];
  },
  addKeyboardShortcuts() {
    return {
      // Alt-F10 is the editor toolbar's (commands/keymap.ts); Shift-Alt-F10 is the block's.
      [THEME_BLOCK_CONTROLS_KEY]: ({ editor }) => focusThemeBlockControls(editor.view),
    };
  },
});

export const TocWithView = Toc.extend({
  addNodeView() {
    return ({ node, view }) => new TocView(node, view);
  },
  addProseMirrorPlugins() {
    return [tocPlugin()];
  },
});
