// The brew item actions of a list page: Copy link (the share URL, with a toast), Clone (POST
// /api/brews/{shareId}/clone, then the copy's editor), Download (the stored brew as a PDF: its
// HTML export, rendered by POST /api/export/pdf) and
// Delete / Remove / Decline (DELETE /api/brews/{editId}: removes the caller; the brew is deleted
// when no owner or author is left) behind one ConfirmDialog. Render `dialog` once in the page.
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, type BrewSummary, type DeleteBrewResponse, fetchBrewForEdit, isAbortError, requestSignIn, useCloneBrew, useDeleteBrew } from '@/api';
import { paths } from '@/app/paths';
import { removeRecentBrew } from '@/app/recentBrews';
import { readDraftsFor } from '@/editor/save/drafts';
import { EXPORT_TOAST_ID, exportFailure, exportSummary } from '@/editor/export/exportSummary';
import { defaultDraftStore, defaultSnapshotHistory } from '@/editor/save/stores';
import { displayTitle } from '@/ported/listPage/listModel';
import { ConfirmDialog, toast } from '@/ui';
import type { BrewItemActions } from './BrewItem';
import { removeCopy } from './brewItemModel';

export interface UseBrewActionsOptions {
  /** A signed-in reader may clone. */
  signedIn: boolean;
  /** After a brew was removed for the reader (deleted, left or declined), before focus moves. */
  onRemoved?: (brew: BrewSummary, result: DeleteBrewResponse) => void;
  /**
   * Asked when a removal is confirmed (the item is still on screen): returns what moves the focus
   * once the dialog has closed and the item is gone (e.g. to the next item), or null.
   */
  focusAfterRemoval?: (brew: BrewSummary) => (() => void) | null;
}

export interface UseBrewActionsResult {
  actionsFor: (brew: BrewSummary) => BrewItemActions;
  /** The confirm dialog (render once). */
  dialog: ReactNode;
}

/** Copies the share page's absolute URL (same wording as the editor's Share menu). */
export async function copyShareLink(shareId: string): Promise<void> {
  const url = new URL(paths.share(shareId), window.location.origin).href;
  try {
    await navigator.clipboard.writeText(url);
    toast({ title: 'Share link copied', description: url, tone: 'success' });
  } catch {
    toast({ title: "Couldn't copy the link", description: url, tone: 'warning' });
  }
}

/**
 * The brew is gone for this reader: forget it on this device, as the editor does after a delete
 * (Recent brews entries, drafts and local history). Best effort.
 */
function forgetBrew(editId: string, shareId: string, deleted: boolean): void {
  removeRecentBrew('edit', editId);
  if (deleted) removeRecentBrew('view', shareId);
  const drafts = defaultDraftStore();
  void readDraftsFor(drafts, editId)
    .then((list) => drafts.delMany(list.map((draft) => draft.key)))
    .catch(() => undefined);
  void defaultSnapshotHistory()
    .clear(editId)
    .catch(() => undefined);
}

export function useBrewActions({ signedIn, onRemoved, focusAfterRemoval }: UseBrewActionsOptions): UseBrewActionsResult {
  const navigate = useNavigate();
  const clone = useCloneBrew({ onSuccess: (copy) => void navigate(paths.edit(copy.editId)) });
  // The export code loads on the first download (the list pages don't need it otherwise).
  const download = useMutation<void, unknown, string>({
    mutationFn: async (editId) => {
      const [brew, exporter] = await Promise.all([fetchBrewForEdit(editId), import('@/editor/export')]);
      const result = await exporter.exportStoredBrewPdf(brew, { title: displayTitle(brew.meta) });
      exporter.downloadFile(result.pdf, result.filename);
      toast({ id: EXPORT_TOAST_ID, ...exportSummary(result, exporter.formatBytes) });
    },
    meta: { errorPolicy: 'manual' },
    onError: (error) => {
      if (isAbortError(error)) return;
      if (error instanceof ApiError && error.status === 401) requestSignIn(error);
      else toast({ id: EXPORT_TOAST_ID, ...exportFailure(error) });
    },
  });
  const remove = useDeleteBrew();
  const [target, setTarget] = useState<BrewSummary | null>(null);
  const pendingFocus = useRef<(() => void) | null>(null);

  // After the dialog has closed (its own focus return has run): move focus where the page wants it.
  useEffect(() => {
    if (target || !pendingFocus.current) return;
    const move = pendingFocus.current;
    pendingFocus.current = null;
    move();
  }, [target]);

  const actionsFor = (brew: BrewSummary): BrewItemActions => {
    const editId = brew.editId;
    return {
      onCopyLink: () => void copyShareLink(brew.shareId),
      onClone: signedIn
        ? () => {
            if (!clone.isPending) clone.mutate(brew.shareId);
          }
        : undefined,
      cloning: clone.isPending && clone.variables === brew.shareId,
      onDownload: editId
        ? () => {
            if (!(download.isPending && download.variables === editId)) download.mutate(editId);
          }
        : undefined,
      downloading: download.isPending && download.variables === editId,
      onRemove: editId ? () => setTarget(brew) : undefined,
    };
  };

  const copy = target ? removeCopy(target) : null;
  const dialog =
    target && copy ? (
      <ConfirmDialog
        open
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={copy.title}
        message={copy.message}
        confirmLabel={copy.confirmLabel}
        tone="danger"
        onConfirm={async () => {
          const editId = target.editId;
          if (!editId) return;
          const focus = focusAfterRemoval?.(target) ?? null;
          const result = await remove.mutateAsync(editId);
          forgetBrew(editId, target.shareId, result.brewDeleted);
          pendingFocus.current = focus;
          toast({ title: copy.done(result.brewDeleted), tone: 'success' });
          onRemoved?.(target, result);
        }}
      />
    ) : null;

  return { actionsFor, dialog };
}
