// Import report UI (plan §7, P6.3). ImportPreview itself is heavy: use LazyImportPreview, or import
// './ImportPreview' where the editor is loaded anyway.
export { ImportReportView, type ImportReportViewProps } from './ImportReportView';
export { LazyImportPreview } from './LazyImportPreview';
export type { ImportPreviewProps, ImportPreviewSettled } from './ImportPreview';
export { DEFAULT_PAGE_WIDTH, fitZoom } from './fitZoom';
export { reportHeadline, reportItems, type LayoutState, type ReportDetails, type ReportItem, type ReportItemsOptions, type ReportTone } from './reportModel';
