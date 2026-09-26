// Local snapshots: five rolling versions of each brew on this device (plan §9, §10). Port of
// legacy/client/homebrew/utils/versionHistory.js, storing the document JSON instead of the
// markdown text.
//
// Rolling rule (unchanged from upstream): slot 1 is the newest. Each slot has an expiry, set when
// a snapshot lands in it: 2 minutes for slot 1, 10 minutes for slot 2, 1 hour for 3, 12 hours for
// 4 and 2 days for 5. A new snapshot looks for the highest expired (or empty) slot, shifts the
// slots below it up by one (the expired one is overwritten) and goes into slot 1. When no slot
// has expired, nothing is stored. So the first five saves fill the slots, and after that the
// versions thin out with age. Snapshots older than 28 days are garbage-collected.
//
// Differences from upstream: snapshots are taken after a successful save (upstream took them
// before sending), so every entry is a version the server also had; the key is the editId
// (upstream: shareId); `force` stores a snapshot even when no slot has expired (the author's own
// version before "Load the saved version" replaces it).
import { fallbackStore, hasIndexedDb, idbStore, memoryStore, type KeyValueStore } from './kvStore';
import type { BrewContent } from './types';

export const SNAPSHOT_DB = 'hb-snapshots';
export const SNAPSHOT_STORE = 'snapshots';
export const SNAPSHOT_SLOTS = 5;
export const SNAPSHOT_FORMAT = 1;
/** Minutes a snapshot keeps its slot, by slot (index 0 unused, as upstream's HISTORY_SAVE_DELAYS). */
export const SNAPSHOT_SLOT_MINUTES: readonly number[] = [0, 2, 10, 60, 12 * 60, 2 * 24 * 60];
/** Snapshots older than this are deleted (upstream GARBAGE_COLLECT_DELAY). */
export const SNAPSHOT_MAX_AGE_MINUTES = 28 * 24 * 60;

const MINUTE = 60_000;

export interface Snapshot extends BrewContent {
  v: typeof SNAPSHOT_FORMAT;
  /** The brew (its editId). */
  brewKey: string;
  /** 1 (newest) … 5. */
  slot: number;
  /** Display title (meta title or the document's first heading). */
  title: string;
  /** The server version this content was saved as, or null. */
  version: number | null;
  docSchemaVersion: number;
  /** When this content was saved (epoch ms); kept when the snapshot moves to another slot. */
  savedAt: number;
  /** Until when the snapshot keeps its slot (epoch ms). */
  expireAt: number;
}

export interface SnapshotInput extends BrewContent {
  brewKey: string;
  title: string;
  version: number | null;
  docSchemaVersion: number;
  savedAt?: number;
}

export type SnapshotStore = KeyValueStore<Snapshot>;

/** IndexedDB, falling back to memory for the page's life when it fails (as drafts do). */
export function createSnapshotStore(): SnapshotStore {
  return hasIndexedDb() ? fallbackStore(idbStore<Snapshot>(SNAPSHOT_DB, SNAPSHOT_STORE)) : memoryStore<Snapshot>();
}

export const snapshotKey = (brewKey: string, slot: number): string => `${brewKey}:${slot}`;

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const doc = v.doc as Record<string, unknown> | null | undefined;
  return (
    v.v === SNAPSHOT_FORMAT &&
    typeof v.brewKey === 'string' &&
    typeof v.slot === 'number' &&
    typeof v.savedAt === 'number' &&
    typeof v.expireAt === 'number' &&
    typeof doc === 'object' &&
    doc !== null &&
    doc.type === 'doc'
  );
}

function toSlot(content: SnapshotInput | Snapshot, slot: number, now: number): Snapshot {
  return {
    v: SNAPSHOT_FORMAT,
    brewKey: content.brewKey,
    slot,
    title: content.title,
    version: content.version,
    docSchemaVersion: content.docSchemaVersion,
    doc: content.doc,
    style: content.style,
    snippets: content.snippets,
    meta: content.meta,
    savedAt: content.savedAt ?? now,
    expireAt: now + (SNAPSHOT_SLOT_MINUTES[slot] ?? 0) * MINUTE,
  };
}

export interface SnapshotHistory {
  /** Slots 1…5 in order; null for an empty slot (upstream's noData item). */
  load(brewKey: string): Promise<(Snapshot | null)[]>;
  /** The stored snapshots, newest first. */
  list(brewKey: string): Promise<Snapshot[]>;
  /**
   * Records `content` if a slot is free (see the rolling rule). Returns whether it was stored.
   * force: when no slot has expired, shift every slot (dropping slot 5) and store anyway.
   */
  update(content: SnapshotInput, options?: { force?: boolean }): Promise<boolean>;
  /** Deletes snapshots saved more than 28 days ago (every brew). Returns how many. */
  collectGarbage(): Promise<number>;
  /** Deletes every snapshot of one brew (it was deleted). */
  clear(brewKey: string): Promise<void>;
}

export function createSnapshotHistory(store: SnapshotStore, now: () => number = Date.now): SnapshotHistory {
  const load = async (brewKey: string): Promise<(Snapshot | null)[]> => {
    const keys = Array.from({ length: SNAPSHOT_SLOTS }, (_, i) => snapshotKey(brewKey, i + 1));
    const values: unknown[] = await store.getMany(keys);
    return values.map((value) => (isSnapshot(value) ? value : null));
  };

  return {
    load,

    async list(brewKey) {
      return (await load(brewKey)).filter((s): s is Snapshot => s !== null);
    },

    async update(content, { force = false } = {}) {
      const time = now();
      const history = await load(content.brewKey);
      // Walk from the oldest slot down to find the highest expired (or empty) one.
      let expired = -1;
      for (let index = SNAPSHOT_SLOTS - 1; index >= 0; index--) {
        const stored = history[index];
        if (!stored || time >= stored.expireAt) {
          expired = index;
          break;
        }
      }
      if (expired < 0) {
        if (!force) return false;
        expired = SNAPSHOT_SLOTS - 1;
      }
      const updates: [string, Snapshot][] = [];
      // Move slot s (index s-1) into slot s+1, from the expired slot down to slot 1.
      for (let slot = expired; slot > 0; slot--) {
        const previous = history[slot - 1];
        if (previous) updates.push([snapshotKey(content.brewKey, slot + 1), toSlot(previous, slot + 1, time)]);
      }
      updates.push([snapshotKey(content.brewKey, 1), toSlot(content, 1, time)]);
      await store.setMany(updates);
      return true;
    },

    async collectGarbage() {
      const time = now();
      const expired: string[] = [];
      for (const [key, value] of await store.entries()) {
        const savedAt = isSnapshot(value) ? value.savedAt : 0;
        if (time > savedAt + SNAPSHOT_MAX_AGE_MINUTES * MINUTE) expired.push(key);
      }
      if (expired.length) await store.delMany(expired);
      return expired.length;
    },

    async clear(brewKey) {
      await store.delMany(Array.from({ length: SNAPSHOT_SLOTS }, (_, i) => snapshotKey(brewKey, i + 1)));
    },
  };
}
