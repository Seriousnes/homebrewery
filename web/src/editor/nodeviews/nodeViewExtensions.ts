import { HbTable, Page } from '../schema';
import { PageView } from './PageView';
import { HbTableView } from './TableView';

/**
 * The page node with PageView as its NodeView. Same name as the schema's Page, so
 * buildEditorExtensions({ extensions: [PageWithView] }) replaces it in place.
 */
export const PageWithView = Page.extend({
  addNodeView() {
    return ({ node, view }) => new PageView(node, view);
  },
});

/** The table node with HbTableView (no div.tableWrapper, no min-width styles). */
export const TableWithView = HbTable.extend({
  addNodeView() {
    return ({ node, view }) => new HbTableView(node, view);
  },
});
