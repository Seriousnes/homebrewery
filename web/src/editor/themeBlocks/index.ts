// Theme blocks (plan §6.4, P5.2) and the live TOC NodeView wiring (§6.5, P5.4).
import type { AnyExtension } from '@tiptap/core';
import { ThemeBlockWithView, TocWithView } from './extension';

export { THEME_BLOCK_CONTROLS_KEY, ThemeBlockWithView, TocWithView } from './extension';
export { ThemeBlockNodeView, renderedAttrs } from './ThemeBlockNodeView';
export { FRAMEABLE_CLASSES, THEME_BLOCK_LABELS, canFrame, humanizeClass, themeBlockLabel } from './labels';
export { activeThemeBlockPos, blockClasses, themeBlockAt, toggleThemeBlockClassTr, type ThemeBlockToggle } from './commands';
export { ThemeBlockOverlay, focusThemeBlockControls, themeBlockOverlayKey, themeBlockOverlayOf, themeBlockOverlayPlugin } from './overlay';
export { ThemeBlockOverlayStore, type ActiveThemeBlock, type ThemeBlockOverlayActions, type ThemeBlockOverlayState } from './overlayStore';

/** The snippets lane's NodeView extensions (also in editorNodeViews, so EditorCanvas has them). */
export const themeBlockNodeViews: AnyExtension[] = [ThemeBlockWithView, TocWithView];
