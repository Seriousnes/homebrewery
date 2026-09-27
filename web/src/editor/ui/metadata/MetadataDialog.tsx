// The metadata ("Properties") dialog of the editor (P3.7): the ported MetadataEditor in a modal
// Dialog, wired to the API: the theme list (GET /api/themes), delete (DELETE /api/brews/{editId})
// and lock reviews (POST /api/brews/{editId}/lock/review).
//
// Saving is not done here. The dialog edits a local draft (initialised from `draft`, or from the
// brew, every time it opens) and reports each accepted edit through onChange; the integrator hands
// `change.meta` to autosave (SaveBrewRequest.meta). Pass the last save's error as serverError to
// show its meta.* validation messages on the fields.
import { useState } from 'react';
import { type BrewLockInfo, type DeleteBrewResponse, useDeleteBrew, useRequestLockReview, useThemes } from '@/api';
import { MetadataEditor } from '@/ported/metadata/MetadataEditor';
import { draftFromBrew, type MetadataBrew, type MetadataChange, type MetaDraft } from '@/ported/metadata/metaDraft';
import { Button, Dialog } from '@/ui';

export interface MetadataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brew: MetadataBrew;
  /** The metadata as the editor has it now (unsaved edits included). Default: from `brew`. */
  draft?: MetaDraft;
  /** Every accepted edit: the field, the new draft and the save payload. */
  onChange: (change: MetadataChange) => void;
  /** The error of the last save (ApiError with meta.* field errors). */
  serverError?: unknown;
  /** After a successful delete (or leave): navigate away. */
  onDeleted?: (result: DeleteBrewResponse, editId: string) => void;
  /** After a review request: the updated lock. */
  onLockChange?: (lock: BrewLockInfo) => void;
  /** This site's origin, for share URLs typed into the theme field. */
  baseUrl?: string;
  /** A local brew (issue #4): no authors, publishing or delete; changes are kept on this device. */
  local?: boolean;
  'data-testid'?: string;
}

export function MetadataDialog({ open, onOpenChange, 'data-testid': testId = 'metadata-dialog', ...rest }: MetadataDialogProps) {
  const local = rest.local === true;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Properties"
      description={local ? 'Changes are saved on this device.' : 'Changes are saved with the brew.'}
      size="lg"
      data-testid={testId}
      footer={
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      {/* The body only exists while open, so the draft starts fresh on every open. */}
      <MetadataDialogBody {...rest} />
    </Dialog>
  );
}

type BodyProps = Omit<MetadataDialogProps, 'open' | 'onOpenChange' | 'data-testid'>;

function MetadataDialogBody({ brew, draft: initialDraft, onChange, serverError, onDeleted, onLockChange, baseUrl, local = false }: BodyProps) {
  const [draft, setDraft] = useState<MetaDraft>(() => initialDraft ?? draftFromBrew(brew));
  const [lock, setLock] = useState<BrewLockInfo | null>(brew.lock);
  // The dialog shows its own message (with Retry) when the list fails, so no policy toast.
  const themes = useThemes({ meta: { errorPolicy: 'manual' } });
  const deleteBrew = useDeleteBrew();
  // A failed request shows its message next to the button.
  const requestReview = useRequestLockReview({ meta: { errorPolicy: 'manual' } });
  const { editId } = brew;

  return (
    <MetadataEditor
      brew={brew}
      draft={draft}
      onChange={(change) => {
        setDraft(change.draft);
        onChange(change);
      }}
      themes={themes.data}
      themesState={themes.isError && !themes.data ? 'error' : themes.data ? 'ready' : 'loading'}
      onRetryThemes={() => void themes.refetch()}
      serverError={serverError}
      {...(baseUrl === undefined ? {} : { baseUrl })}
      lock={lock}
      local={local}
      {...(editId && !local
        ? {
            onDelete: async () => {
              const result = await deleteBrew.mutateAsync(editId);
              onDeleted?.(result, editId);
            },
            onRequestReview: async () => {
              const next = await requestReview.mutateAsync(editId);
              setLock(next);
              onLockChange?.(next);
              return next;
            },
          }
        : {})}
    />
  );
}
