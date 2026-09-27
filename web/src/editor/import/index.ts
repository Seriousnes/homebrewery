// Markdown import (plan §7, P6.2): brew text → document.
export { hbfmToDoc, ImportError, DEFAULT_IMPORT_THEME, type HbfmToDocOptions, type HbfmImportResult, type ImportErrorCode } from './hbfmToDoc';
export { splitTextStyleAndMetadata, yamlSnippetsToText, brewSnippetsToJSON } from './brewText';
export type { BrewMetadata, SplitBrew, BrewTextInput, BrewSnippet, BrewSnippetGroup, BrewSnippetsJSON } from './brewText';
export { sanitizeImportHtml, sanitizeImportHtmlDetailed, realRemovals, IMPORT_HTML_TAGS, IMPORT_HTML_ATTRS, type SanitizeResult, type SanitizeRemovals } from './sanitize';
export { ImportReport, recordPaginatedPages, sectionPageCounts, type ImportReportData, type ClippedPage, type GrownPage } from './importReport';
export { createHbfmRenderer, processStyleTags, type HbfmRenderer, type HbfmRendererOptions, type InjectedTags, type VariablesMode } from './hbfm/renderer';
export { BrewVariables, type BrewVariablesOptions, type VariableDefinition } from './hbfm/variables';
export { evaluateMath } from './hbfm/math';
export { PAGE_SPLIT, splitPages, stripPageLine, pageLine, pageShellFromTags, buildPageElement, type PageShell } from './pages';
export { analyzePage, applyLift, containingBlock, measureClipping, type PageAnalysis, type LiftCounts, type PositionedInFlow } from './lift';
export { UPSTREAM_BASE_CSS, PROBE_LAYOUT_CSS, OPEN_SANS_CSS } from './upstreamBase';
