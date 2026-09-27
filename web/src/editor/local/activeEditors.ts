// The local brews open in an editor in this tab (issue #4). An upload started anywhere (the
// editor's Upload, the sign-in prompt's Upload all, Brews on this device) first lets that editor
// store what it has and stop writing: the upload then has the latest content, and no later write
// brings the uploaded brew back to this device. After the upload the editor opens the cloud brew;
// if it fails, the editor writes again.
import type { BrewForEdit } from '@/api';

export interface ActiveLocalEditor {
  /** Stores pending changes and stops writing (and editing). Resolves false when storing failed. */
  prepareUpload(): Promise<boolean>;
  /** The brew is in the cloud now (and gone from this device). */
  uploaded(created: BrewForEdit): void;
  /** The upload failed: write and edit again. */
  uploadFailed(): void;
}

const editors = new Map<string, ActiveLocalEditor>();

/** Registers the editor of local brew `localId`; returns the unregister function. */
export function registerActiveLocalEditor(localId: string, editor: ActiveLocalEditor): () => void {
  editors.set(localId, editor);
  return () => {
    if (editors.get(localId) === editor) editors.delete(localId);
  };
}

/** The editor that has local brew `localId` open in this tab, if any. */
export function activeLocalEditor(localId: string): ActiveLocalEditor | null {
  return editors.get(localId) ?? null;
}
