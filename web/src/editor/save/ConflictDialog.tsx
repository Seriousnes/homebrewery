// The 409 dialog (plan §9): autosave has stopped because the brew was saved elsewhere. Three
// ways out, each explained next to its button; Escape or the close button leaves the conflict
// open (the status's "Resolve…" button brings the dialog back).
import { useId, useRef } from 'react';
import { Button, Dialog } from '@/ui';
import styles from './save.module.css';
import type { UseAutosaveResult } from './useAutosave';

export interface ConflictDialogProps {
  autosave: UseAutosaveResult;
}

export function ConflictDialog({ autosave }: ConflictDialogProps) {
  const copyRef = useRef<HTMLButtonElement>(null);
  const loadHint = useId();
  const overwriteHint = useId();
  const copyHint = useId();
  const conflict = autosave.conflict;
  const busy = conflict?.busy ?? null;
  const blocked = busy !== null;

  return (
    <Dialog
      open={autosave.conflictOpen}
      onOpenChange={(open) => {
        if (!open) autosave.closeConflict();
      }}
      role="alertdialog"
      title="This brew was changed somewhere else"
      description="A newer version was saved from another tab, device or author. Autosave is paused until you choose what to keep."
      closeOnOverlayClick={false}
      initialFocusRef={copyRef}
      data-testid="conflict-dialog"
    >
      {conflict?.actionError && (
        <p className={styles.actionError} role="alert" data-testid="conflict-error">
          {conflict.actionError}
        </p>
      )}
      <ul className={styles.options}>
        <li className={styles.option}>
          <Button
            onClick={() => void autosave.loadSavedVersion()}
            loading={busy === 'load'}
            aria-disabled={blocked && busy !== 'load' ? true : undefined}
            aria-describedby={loadHint}
            data-testid="conflict-load"
          >
            Load the saved version
          </Button>
          <p id={loadHint} className={styles.optionHint}>
            Replaces your changes with the saved version. Undo (Ctrl+Z) brings yours back, and a copy stays in Local history.
          </p>
        </li>
        <li className={styles.option}>
          <Button
            variant="danger"
            onClick={() => void autosave.overwriteWithMine()}
            loading={busy === 'overwrite'}
            aria-disabled={blocked && busy !== 'overwrite' ? true : undefined}
            aria-describedby={overwriteHint}
            data-testid="conflict-overwrite"
          >
            Overwrite with mine
          </Button>
          <p id={overwriteHint} className={styles.optionHint}>
            Saves your version over the other one. The other changes are lost.
          </p>
        </li>
        <li className={styles.option}>
          <Button
            ref={copyRef}
            variant="primary"
            onClick={() => void autosave.saveAsCopy()}
            loading={busy === 'copy'}
            aria-disabled={blocked && busy !== 'copy' ? true : undefined}
            aria-describedby={copyHint}
            data-testid="conflict-copy"
          >
            Save mine as a copy
          </Button>
          <p id={copyHint} className={styles.optionHint}>
            Keeps the saved version as it is and saves yours as a new brew, which opens here.
          </p>
        </li>
      </ul>
    </Dialog>
  );
}
