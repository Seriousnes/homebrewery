// Header rows (P5.6): the leading rows of a table whose cells are all header cells get the class
// hb-header-row (a node decoration, so it is never stored or exported). They stand in for
// upstream's <thead>: theme and user CSS for `thead` and `tbody` rows is rewritten to match them
// (headerRowSelectors.ts, applied by web/vite/scopeThemes.ts and canvas/cssScope.ts), and
// canvas.css keeps them `display: table-row`. Export (P6.4) moves these rows into a real <thead>.
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { touchesNode } from '../schema/plugins/stepScope';
import { HEADER_ROW_CLASS } from './headerRowSelectors';

export { HEADER_ROW_CLASS };

export const headerRowsKey = new PluginKey<DecorationSet>('hbTableHeaderRows');

/** Whether every cell of the row is a header cell (an empty row is not a header row). */
export function isHeaderRow(row: PMNode): boolean {
  if (row.childCount === 0) return false;
  let all = true;
  row.forEach((cell) => {
    if (cell.type.spec.tableRole !== 'header_cell') all = false;
  });
  return all;
}

/** Number of leading all-header rows of a table node. */
export function headerRowCount(table: PMNode): number {
  let count = 0;
  for (let i = 0; i < table.childCount; i++) {
    if (!isHeaderRow(table.child(i))) break;
    count++;
  }
  return count;
}

/** Positions (before the row) of the leading header rows of every table in `doc`. */
export function headerRowPositions(doc: PMNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === 'table') {
      let rowPos = pos + 1;
      const count = headerRowCount(node);
      for (let i = 0; i < count; i++) {
        positions.push(rowPos);
        rowPos += node.child(i).nodeSize;
      }
      return false; // header rows of nested tables are not upstream's concern
    }
    // Tables are blocks: never look inside text.
    return !node.isTextblock && !node.isAtom;
  });
  return positions;
}

const isTableNode = (node: PMNode): boolean => node.type.spec.tableRole !== undefined;

function decorations(doc: PMNode): DecorationSet {
  const decos = headerRowPositions(doc).map((pos) => {
    const row = doc.nodeAt(pos)!;
    return Decoration.node(pos, pos + row.nodeSize, { class: HEADER_ROW_CLASS });
  });
  return DecorationSet.create(doc, decos);
}

export function headerRowsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: headerRowsKey,
    state: {
      init: (_config, state: EditorState) => decorations(state.doc),
      // Rebuilt when a table (or anything in one) was touched; otherwise the rows only moved:
      // mapped (P8.1: typing in a paragraph or a pagination step doesn't walk the whole brew, and
      // unchanged pages keep equal decorations for the view update).
      apply: (tr, previous) => {
        if (!tr.docChanged) return previous;
        return touchesNode([tr], isTableNode) ? decorations(tr.doc) : previous.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return headerRowsKey.getState(state);
      },
    },
  });
}

/**
 * TipTap extension for the header-row decoration. EditorCanvas includes it (editorNodeViews), so
 * every canvas styles header rows like upstream.
 */
export const TableHeaderRows = Extension.create({
  name: 'hbTableHeaderRows',
  addProseMirrorPlugins() {
    return [headerRowsPlugin()];
  },
});
