// Automatic pagination (plan §4). See plugin.ts for the scheduler, step.ts for one step,
// boundary.ts for the document changes, measure.ts and cut.ts for the layout rules,
// sections.ts for the section settings of auto pages, fragments.ts for split blocks.
export {
  autoPageAttrs,
  carriesPageData,
  continuationAttrs,
  endOfFirstBlock,
  insertAutoPageAt,
  isAutoPage,
  isPlaceholderPage,
  moveBoundary,
  normalizeCut,
  pageAt,
  pageIndexAt,
  rejoinContinuations,
  renumberContinuations,
  sectionEndIndex,
  sectionStartIndex,
  splitToPage,
  type MoveResult,
  type PageRef,
} from './boundary';
export { chooseCut, firstPosOutside, keepWithNext, type CutChoice, type CutRule } from './cut';
export { Pagination } from './extension';
export {
  FRAGMENT_ATTRS,
  KEEP_CONTINUATIONS,
  addSharedFragmentAttrs,
  clearOrphanedContinuations,
  fragmentChain,
  isAuthorChange,
  shareFragmentAttrs,
  updateAttributes,
} from './fragments';
export { FailedPulls, domLayout, failedPulls, parityMatters } from './layout';
export {
  EPS,
  IMAGE_WAIT_MS,
  blockRects,
  contentBox,
  firstUnitHeight,
  measurePage,
  measurePageStatus,
  pageGeometry,
  pullTarget,
  scaleOf,
  type Box,
  type Geometry,
  type OverflowHit,
  type PageMeasure,
} from './measure';
export {
  WAITING_RECHECK_MS,
  changedPages,
  defaultMaxSteps,
  isPaginationPaused,
  paginationPlugin,
  repaginate,
  setPaginationProfiler,
  settleNow,
  type PaginationFrameProfile,
  type PaginationOptions,
  type SettleInfo,
} from './plugin';
export { sameSectionValue, sectionSyncKey, sectionSyncPlugin, syncSectionAttrs } from './sections';
export {
  PAGINATE,
  REPAGINATE,
  SECTION_SYNC,
  isPaginating,
  isSettled,
  paginateSteps,
  paginationKey,
  paginationState,
  type PaginateMeta,
  type PaginateStep,
  type PaginationState,
  type PaginationStats,
  type RepaginateMeta,
  type StepAction,
} from './state';
export { paginatePage, type LayoutMeasure, type PageLayout, type PaginationProgress, type StepResult } from './step';
export { JoinPagesStep, PageBreakStep, restorePageAt, secondPartAttrs } from './pageSteps';
