// The app's shared draft and snapshot stores (one per page, created on first use).
import { createDraftStore, type DraftStore } from './drafts';
import { createSnapshotHistory, createSnapshotStore, type SnapshotHistory } from './snapshots';

let drafts: DraftStore | undefined;
let snapshots: SnapshotHistory | undefined;

/** IndexedDB 'hb-drafts' (in memory where IndexedDB is missing). */
export function defaultDraftStore(): DraftStore {
  return (drafts ??= createDraftStore());
}

/** IndexedDB 'hb-snapshots' (in memory where IndexedDB is missing). */
export function defaultSnapshotHistory(): SnapshotHistory {
  return (snapshots ??= createSnapshotHistory(createSnapshotStore()));
}
