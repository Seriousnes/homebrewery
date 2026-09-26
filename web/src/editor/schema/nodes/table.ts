// Tables: TipTap's table nodes (prosemirror-tables roles, commands and editing plugins),
// rendered like marked-extended-tables output so theme table rules keep matching:
//
//   table › tbody › tr › th|td[colspan][rowspan][align][width]
//
// Differences from TipTap's defaults, all for the CSS contract:
// - colspan/rowspan are written only when > 1 (5ePHB styles `th[colspan]:not([rowspan])`).
// - align is the `align` attribute (as upstream), not an inline text-align style, so it can't
//   leak into the generic `style` attribute on a round trip.
// - `width` keeps upstream's percentage column widths (`|:--50%--:|`); `colwidth` keeps TipTap's
//   pixel widths, rendered through a colgroup only when a width is set.
// - No inline min-width style on the table.
//
// Known gap (for S3 / P5.6): upstream puts header rows in <thead>; ProseMirror renders a node's
// children into one element, so every row is in <tbody>. Theme rules for `thead` and
// `tbody tr:nth-child(odd)` striping therefore see different rows. Fix it in a table NodeView or
// export post-processing.
import type { Attribute } from '@tiptap/core';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { Node as PMNode, DOMOutputSpec } from '@tiptap/pm/model';

export type CellAlign = 'left' | 'right' | 'center';
const CELL_ALIGNS: readonly string[] = ['left', 'right', 'center'];

function positiveInt(value: string | null, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const cellAttributes: Record<string, Attribute> = {
  colspan: {
    default: 1,
    validate: 'number',
    parseHTML: (el) => positiveInt(el.getAttribute('colspan'), 1),
    renderHTML: (a) => (typeof a.colspan === 'number' && a.colspan > 1 ? { colspan: a.colspan } : {}),
  },
  rowspan: {
    default: 1,
    validate: 'number',
    parseHTML: (el) => positiveInt(el.getAttribute('rowspan'), 1),
    renderHTML: (a) => (typeof a.rowspan === 'number' && a.rowspan > 1 ? { rowspan: a.rowspan } : {}),
  },
  colwidth: {
    default: null,
    parseHTML: (el) => {
      const raw = el.getAttribute('colwidth');
      if (!raw) return null;
      const widths = raw.split(',').map((w) => parseInt(w, 10));
      return widths.every((w) => Number.isFinite(w) && w > 0) ? widths : null;
    },
    renderHTML: (a) => (Array.isArray(a.colwidth) && a.colwidth.length ? { colwidth: a.colwidth.join(',') } : {}),
  },
  align: {
    default: null,
    validate: 'string|null',
    parseHTML: (el) => {
      const align = (el.getAttribute('align') ?? '').trim().toLowerCase();
      return CELL_ALIGNS.includes(align) ? align : null;
    },
    renderHTML: (a) => (typeof a.align === 'string' && CELL_ALIGNS.includes(a.align) ? { align: a.align } : {}),
  },
  width: {
    default: null,
    validate: 'string|null',
    parseHTML: (el) => el.getAttribute('width')?.trim() || null,
    renderHTML: (a) => (typeof a.width === 'string' && a.width !== '' ? { width: a.width } : {}),
  },
};

export const HbTableCell = TableCell.extend({
  addAttributes() {
    return { ...cellAttributes };
  },
});

export const HbTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...cellAttributes };
  },
});

export const HbTableRow = TableRow;

/** colgroup for pixel column widths (colwidth), or null when no column has one. */
function colgroupSpec(table: PMNode): DOMOutputSpec | null {
  const row = table.firstChild;
  if (!row) return null;
  const cols: DOMOutputSpec[] = [];
  let any = false;
  row.forEach((cell) => {
    const colspan = typeof cell.attrs.colspan === 'number' ? cell.attrs.colspan : 1;
    const widths = Array.isArray(cell.attrs.colwidth) ? (cell.attrs.colwidth as unknown[]) : [];
    for (let i = 0; i < colspan; i++) {
      const w = widths[i];
      if (typeof w === 'number' && w > 0) {
        any = true;
        cols.push(['col', { style: `width: ${w}px` }]);
      } else {
        cols.push(['col', {}]);
      }
    }
  });
  return any ? ['colgroup', {}, ...cols] : null;
}

export const HbTable = Table.extend({
  renderHTML({ node, HTMLAttributes }) {
    const colgroup = colgroupSpec(node);
    return colgroup ? ['table', HTMLAttributes, colgroup, ['tbody', 0]] : ['table', HTMLAttributes, ['tbody', 0]];
  },
}).configure({ resizable: false, renderWrapper: false });
