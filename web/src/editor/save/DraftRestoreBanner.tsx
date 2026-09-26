// "Restore unsaved changes" (plan §9): shown when this device holds a draft of the brew that
// differs from the loaded version (a closed or crashed tab, a lost connection, a conflict left
// unresolved). A draft made on the loaded version (kind 'restore') is restored as one undo step;
// one made on an older version or in a conflict (kind 'conflict') is restored into the editor
// with the conflict dialog open, so nothing overwrites the newer version unless the author
// chooses to. The live region is always mounted so the offer is announced when it appears.
// Also a lasting notice when this browser refuses to store drafts (SAVE-11).
import { useId } from 'react';
import { Button, Icon, VisuallyHidden } from '@/ui';
import styles from './save.module.css';
import { formatRelative, formatSavedAt } from './statusText';
import type { UseAutosaveResult } from './useAutosave';

export interface DraftRestoreBannerProps {
  autosave: UseAutosaveResult;
  className?: string;
}

export function DraftRestoreBanner({ autosave, className }: DraftRestoreBannerProps) {
  const titleId = useId();
  const noticeId = useId();
  const draft = autosave.draftOffer;
  const when = draft ? `${formatSavedAt(draft.updatedAt)} (${formatRelative(draft.updatedAt)})` : '';
  const conflict = draft?.kind === 'conflict';
  const bannerClass = [styles.banner, className].filter(Boolean).join(' ');

  const focusEditor = () => {
    const editor = autosave.editor;
    if (editor && !editor.isDestroyed) editor.view.focus();
  };

  return (
    <>
      <VisuallyHidden role="status" aria-live="polite">
        {draft ? `Unsaved changes from ${when} were found on this device.` : ''}
      </VisuallyHidden>
      {!autosave.draftsPersistent && (
        <section className={bannerClass} aria-labelledby={noticeId} data-testid="drafts-not-kept">
          <Icon name="warning" size={20} className={styles.bannerIcon} />
          <div className={styles.bannerText}>
            <h2 id={noticeId} className={styles.bannerTitle}>
              Unsaved changes can’t be kept on this device
            </h2>
            <p className={styles.bannerMessage}>
              This browser doesn’t let the site store data, so changes that aren’t saved yet are lost when you close or reload the page.
            </p>
          </div>
        </section>
      )}
      {draft && (
        <section className={bannerClass} aria-labelledby={titleId} data-testid="draft-offer" data-kind={draft.kind}>
          <Icon name={conflict ? 'warning' : 'info'} size={20} className={styles.bannerIcon} />
          <div className={styles.bannerText}>
            <h2 id={titleId} className={styles.bannerTitle}>
              Unsaved changes found
            </h2>
            <p className={styles.bannerMessage}>
              {conflict
                ? `This device kept changes to this brew from ${when} that were never saved, and the brew was saved again since then. Restoring them lets you choose which version to keep.`
                : `This device kept changes to this brew from ${when} that were never saved.`}
            </p>
          </div>
          <div className={styles.bannerActions}>
            <Button
              variant="primary"
              size="sm"
              data-testid="draft-restore"
              aria-haspopup={conflict ? 'dialog' : undefined}
              onClick={() => {
                autosave.restoreDraft();
                if (!conflict) focusEditor(); // a conflict opens its dialog, which takes the focus
              }}
            >
              {conflict ? 'Restore unsaved changes…' : 'Restore unsaved changes'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="draft-discard"
              onClick={() => {
                void autosave.discardDraft();
                focusEditor();
              }}
            >
              Discard
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
