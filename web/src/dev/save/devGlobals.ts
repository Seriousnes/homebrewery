// What /dev/save exposes to Playwright (web/e2e/save). Dev only.
import type { Editor, JSONContent } from '@tiptap/core';
import type { AutosaveState, Draft, Snapshot } from '@/editor/save';

export interface SaveDevGlobals {
  editor: Editor;
  state: () => AutosaveState;
  /** The newest stored draft of a brew (any session's key), or the 'new' draft; from IndexedDB. */
  draft: (key: string) => Promise<Draft | null>;
  /** Every stored draft of a brew, newest first. */
  drafts: (editId: string) => Promise<Draft[]>;
  snapshots: (editId: string) => Promise<Snapshot[]>;
  saveNow: () => Promise<string>;
  /**
   * A round trip through idbStore (IndexedDB 'hb-e2e-kv' / 'kv'): each call of KeyValueStore once,
   * with what came back (web/e2e/save/stores.spec.ts).
   */
  idbRoundTrip: () => Promise<unknown>;
}

declare global {
  interface Window {
    __hbSave?: SaveDevGlobals;
  }
}

/** A new brew: one page with an empty paragraph. */
export const BLANK_DOC: JSONContent = { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph' }] }] };
