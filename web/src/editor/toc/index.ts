// The live table of contents (plan §6.5, P5.4): entries from the document, upstream's markup,
// refreshed after pagination settles. The NodeView is nodeviews/TocView.ts; the extension that
// attaches it is TocWithView (themeBlocks/extension.ts).
export {
  collectHeadings,
  pageNumbering,
  tocEntries,
  tocKeyword,
  tocTree,
  type PageNumbering,
  type TocEntry,
  type TocHeading,
  type TocOptions,
  type TocTreeItem,
} from './computeToc';
export { entryWrapper, escapeHtml, tocClass, tocHtml, tocInnerHtml, type TocRenderAttrs } from './renderToc';
export {
  MAX_TOC_REPAGINATIONS,
  isExcludedByTheme,
  refreshTocs,
  registerToc,
  scheduleTocRefresh,
  tocPlugin,
  tocPluginKey,
  tocTargets,
  unregisterToc,
  type TocTarget,
} from './tocPlugin';
