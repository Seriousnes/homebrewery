// Plugins that belong with the schema. editorExtensions.ts adds them to every editor.
export { HeadingIds, assignHeadingIds, headingIdUpdates, headingIdsKey, type HeadingIdUpdate } from './headingIds';
export { PageIds, assignPageIds, newPageId, pageIdsKey, pagesNeedingIds } from './pageIds';
export { PageIndexIds, pageDomId, pageIndexIdsKey, syncPageDomIds } from './pageIndexIds';
export { PagesRoot } from './pagesRoot';
export { LAYOUT_NEUTRAL_META } from './meta';
export { runOnceAfterInit } from './runOnce';
export { survivors, type Survives } from './survivors';
