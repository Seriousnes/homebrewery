// NodeViews of the editor. Each is the schema extension extended with addNodeView (never with
// schema changes), so buildEditorExtensions({ extensions: editorNodeViews }) swaps it in place.
import type { AnyExtension } from '@tiptap/core';
import { PageWithView, TableWithView } from './nodeViewExtensions';
// Snippets lane (P5.2, P5.4): theme-block label/toggles and the live TOC.
import { ThemeBlockWithView, TocWithView } from '../themeBlocks/extension';
// Objects lane (P5.6, plan §6.6): header rows styled like <thead>; images with natural sizes.
import { ImageWithView } from '../objects/imageView';
import { TableHeaderRows } from '../tables/headerRows';
// Tables (T3): the table controls under the table at the caret (editable canvases only).
import { TableControls } from '../tables/controls';
import { CaretBlock } from '../ui/blockMenu/caretBlock';

export {
  CHROME_ATTR,
  OBJECT_ID_ATTR,
  OVERSIZED_BADGE_CLASS,
  OVERSIZED_BADGE_TEXT,
  OVERSIZED_BADGE_TITLE,
  OVERSIZED_CLASS,
  PageView,
  sameAttrs,
} from './PageView';
export { HbTableView } from './TableView';
export { PageWithView, TableWithView } from './nodeViewExtensions';

/** Every NodeView extension of the canvas lane (P3.2): page and table; plus the snippets lane's theme block and toc; plus the objects lane's image view, header-row and caret-block decorations; plus the table controls. */
export const editorNodeViews: AnyExtension[] = [PageWithView, TableWithView, ThemeBlockWithView, TocWithView, ImageWithView, TableHeaderRows, CaretBlock, TableControls];
