// Autosave, conflict dialog, IndexedDB drafts and local snapshots (plan §9, P3.8).
// Import from '@/editor/save'.
export {
  AUTOSAVE_DELAY_MS,
  createAutosave,
  defaultAutosaveApi,
  DRAFT_THROTTLE_MS,
  findFirstHeading,
  KEEPALIVE_MAX_BYTES,
  RETRY_DELAYS_MS,
  SAVE_NOW_SETTLE_MS,
  SAVE_TIMEOUT_MS,
  SETTLE_TIMEOUT_MS,
  STALLED_SAVE_MS,
  type AutosaveApi,
  type AutosaveConflict,
  type AutosaveController,
  type AutosaveOptions,
  type AutosaveState,
  type ConflictAction,
  type LeaveScope,
  type SaveOutcome,
  type AutosaveStatus,
  type SaveTrigger,
} from './autosave';
export { docFromJson, replaceDocTransaction, replaceDocument, type ReplaceDocumentOptions } from './applyDoc';
export { createChainOf, CreateChainContext, newCreateKey, type CreateChain } from './createChain';
export { patchSavedBrew, seedCreatedBrew } from './cache';
export { isDirtyDispatch, isDirtyTransaction, SERVER_DOC_META } from './dirty';
export {
  createDraftStore,
  DRAFT_DB,
  DRAFT_STORE,
  draftDiffers,
  draftKey,
  draftOfferKind,
  draftOwnedBy,
  isDraft,
  NEW_DRAFT_KEY,
  readDraft,
  readDraftsFor,
  shouldOfferDraft,
  type Draft,
  type DraftOffer,
  type DraftOfferKind,
  type DraftStore,
} from './drafts';
export { jsonEqual } from './jsonEqual';
export {
  createdFromDraft,
  pendingNewBrewCreates,
  trackNewBrewCreate,
  type NewBrewCreate,
  type NewBrewCreateHandle,
  type NewBrewCreateStatus,
} from './newBrewCreates';
export { fallbackStore, hasIndexedDb, idbStore, memoryStore, type FallbackStore, type KeyValueStore } from './kvStore';
export {
  createSnapshotHistory,
  createSnapshotStore,
  SNAPSHOT_DB,
  SNAPSHOT_MAX_AGE_MINUTES,
  SNAPSHOT_SLOT_MINUTES,
  SNAPSHOT_SLOTS,
  SNAPSHOT_STORE,
  snapshotKey,
  type Snapshot,
  type SnapshotHistory,
  type SnapshotInput,
  type SnapshotStore,
} from './snapshots';
export { formatRelative, formatSavedAt, saveStatusInfo, type StatusInfo, type StatusTone } from './statusText';
export { defaultDraftStore, defaultSnapshotHistory } from './stores';
export type { BrewBaseline, BrewContent } from './types';
export { isSaveShortcut, useAutosave, type UseAutosaveOptions, type UseAutosaveResult } from './useAutosave';
export { ConflictDialog, type ConflictDialogProps } from './ConflictDialog';
export { DraftRestoreBanner, type DraftRestoreBannerProps } from './DraftRestoreBanner';
export { LeaveGuard, type LeaveGuardProps } from './LeaveGuard';
export { LocalHistoryDialog, type LocalHistoryDialogProps } from './LocalHistoryDialog';
export { SaveStatus, type SaveStatusProps } from './SaveStatus';
