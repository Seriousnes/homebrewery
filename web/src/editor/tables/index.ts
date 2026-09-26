// Tables (P5.6): header rows styled like upstream's <thead>, and table commands beyond TipTap's.
export * from './commands';
export { HEADER_ROW_CLASS, headerRowCount, headerRowPositions, headerRowsKey, headerRowsPlugin, isHeaderRow, TableHeaderRows } from './headerRows';
export { rewriteHeaderRowSelector, rewriteHeaderRowSelectorList, splitSelectors } from './headerRowSelectors';
