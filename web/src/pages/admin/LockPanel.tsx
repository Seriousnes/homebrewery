// A brew's lock tools (port of upstream's legacy/client/admin/lockTools "Lock Brew", "Unlock Brew"
// and "Clear Review Request", plan §8.6): the current lock (code, messages, review request) with
// Unlock and Dismiss review, and the lock form (code prefilled with upstream's 455 and its
// suggested codes, the authors' message, the readers' message). Every action is confirmed first;
// the lists and this brew are fetched again afterwards (no optimistic updates).
import { type FormEvent, useId, useRef, useState } from 'react';
import type { AdminBrewInfo } from '@/api';
import { useAdminDismissReview, useAdminLockBrew, useAdminUnlockBrew } from '@/api/admin';
import { Button, Icon, TextArea, TextField, toast } from '@/ui';
import styles from './Admin.module.css';
import {
  apiFieldErrors,
  LOCK_CODES,
  LOCK_FIELD_LABELS,
  type LockDraft,
  lockDraftFor,
  type LockErrors,
  type LockField,
  MAX_LOCK_CODE,
  MAX_LOCK_MESSAGE,
  MIN_LOCK_CODE,
  lockCodeText,
  validateLock,
} from './adminModel';
import { Time } from './adminParts';
import { useConfirmAction } from './useConfirmAction';

const FIELDS: readonly LockField[] = ['code', 'editMessage', 'shareMessage'];

export function LockPanel({ brew }: { brew: AdminBrewInfo }) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { confirm, dialog } = useConfirmAction();
  const unlock = useAdminUnlockBrew();
  const dismiss = useAdminDismissReview();
  const lock = brew.lock;
  const title = brew.title || 'Untitled brew';

  const askUnlock = () =>
    confirm({
      title: 'Unlock this brew?',
      message: `“${title}” becomes readable on its share page again, and its authors no longer see the lock message.`,
      confirmLabel: 'Unlock',
      tone: 'danger',
      errorTitle: "Couldn't unlock the brew",
      run: async () => {
        await unlock.mutateAsync(brew.shareId);
        toast({ title: 'Brew unlocked', description: title, tone: 'success' });
      },
      focusAfter: () => headingRef.current,
    });

  const askDismiss = () =>
    confirm({
      title: 'Dismiss the review request?',
      message: `“${title}” stays locked. Its authors can ask for a review again.`,
      confirmLabel: 'Dismiss request',
      tone: 'danger',
      errorTitle: "Couldn't dismiss the review request",
      run: async () => {
        await dismiss.mutateAsync(brew.shareId);
        toast({ title: 'Review request dismissed', description: title, tone: 'success' });
      },
      focusAfter: () => headingRef.current,
    });

  return (
    <section className={styles.card} aria-labelledby={headingId} data-testid="admin-lock-panel">
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
        Lock
      </h2>
      {lock ? (
        <div className={styles.lockBox} data-testid="admin-lock-current">
          <h3 className={styles.lockBoxTitle}>
            <Icon name="lock" size={18} />
            Locked <Time value={lock.applied} relative />
          </h3>
          <dl className={styles.facts}>
            <div>
              <dt>Code</dt>
              <dd data-testid="admin-lock-code">{lockCodeText(lock.code)}</dd>
            </div>
            <div>
              <dt>Locked</dt>
              <dd>
                <Time value={lock.applied} />
              </dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd data-testid="admin-lock-review">
                {lock.reviewRequested ? (
                  <>
                    Requested <Time value={lock.reviewRequested} />
                  </>
                ) : (
                  'Not requested'
                )}
              </dd>
            </div>
            <div>
              <dt>{LOCK_FIELD_LABELS.editMessage}</dt>
              <dd className={styles.preLine} data-testid="admin-lock-edit-message">
                {lock.editMessage}
              </dd>
            </div>
            <div>
              <dt>{LOCK_FIELD_LABELS.shareMessage}</dt>
              <dd className={styles.preLine} data-testid="admin-lock-share-message">
                {lock.shareMessage}
              </dd>
            </div>
          </dl>
          <div className={`${styles.actions} ${styles.lockActions}`}>
            {lock.reviewRequested ? (
              <Button onClick={askDismiss} data-testid="admin-dismiss-review">
                Dismiss review request
              </Button>
            ) : null}
            <Button variant="danger" icon="unlock" onClick={askUnlock} data-testid="admin-unlock">
              Unlock
            </Button>
          </div>
        </div>
      ) : (
        <p className={styles.text} data-testid="admin-lock-none">
          This brew is not locked.
        </p>
      )}
      {/* A new lock (or none) starts the form again from the stored values. */}
      <LockForm key={lock?.applied ?? 'unlocked'} brew={brew} confirm={confirm} focusAfter={() => headingRef.current} />
      {dialog}
    </section>
  );
}

interface LockFormProps {
  brew: AdminBrewInfo;
  confirm: ReturnType<typeof useConfirmAction>['confirm'];
  /** Where focus goes after a lock change (this form is replaced by a new one then). */
  focusAfter: () => HTMLElement | null;
}

function LockForm({ brew, confirm, focusAfter }: LockFormProps) {
  const lockBrew = useAdminLockBrew();
  const [draft, setDraft] = useState<LockDraft>(() => lockDraftFor(brew.lock));
  const [errors, setErrors] = useState<LockErrors>({});
  const headingId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const shareRef = useRef<HTMLTextAreaElement>(null);
  const relock = brew.lock != null;
  const title = brew.title || 'Untitled brew';

  const showErrors = (found: LockErrors) => {
    setErrors(found);
    const first = FIELDS.find((field) => found[field]);
    const target = first === 'code' ? codeRef : first === 'editMessage' ? editRef : first === 'shareMessage' ? shareRef : null;
    target?.current?.focus();
  };

  const change = (field: LockField, value: string) => {
    setDraft((old) => ({ ...old, [field]: value }));
    setErrors((old) => (old[field] ? { ...old, [field]: undefined } : old));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { errors: found, request } = validateLock(draft);
    if (!request) {
      showErrors(found);
      return;
    }
    setErrors({});
    confirm({
      title: relock ? 'Change the lock?' : 'Lock this brew?',
      message: relock
        ? `The new code and messages replace the current lock of “${title}”, and any review request is cleared.`
        : `Readers of “${title}” see your message instead of the brew, and its authors see why in the editor.`,
      confirmLabel: relock ? 'Update lock' : 'Lock brew',
      tone: 'danger',
      errorTitle: "Couldn't lock the brew",
      run: async () => {
        await lockBrew.mutateAsync({ shareId: brew.shareId, lock: request });
        toast({ title: relock ? 'Lock updated' : 'Brew locked', description: `${title} (code ${request.code})`, tone: 'success' });
      },
      focusAfter,
      onError: (error) => {
        const fromApi = apiFieldErrors(error, LOCK_FIELD_LABELS);
        if (Object.keys(fromApi).length > 0) showErrors(fromApi);
      },
    });
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-labelledby={headingId} data-testid="admin-lock-form">
      <h3 id={headingId} className={styles.subTitle}>
        {relock ? 'Change the lock' : 'Lock this brew'}
      </h3>
      <TextField
        ref={codeRef}
        className={styles.codeField}
        label={LOCK_FIELD_LABELS.code}
        name="code"
        inputMode="numeric"
        autoComplete="off"
        required
        hint={`${MIN_LOCK_CODE} to ${MAX_LOCK_CODE}. Shown to readers and authors.`}
        value={draft.code}
        error={errors.code}
        onChange={(event) => change('code', event.target.value)}
        data-testid="admin-lock-code-input"
      />
      <details className={styles.codes}>
        <summary>Suggested codes</summary>
        <ul className={styles.codeList}>
          {LOCK_CODES.map(({ code, label }) => (
            <li key={code}>
              <Button
                size="sm"
                pressed={draft.code.trim() === String(code)}
                onClick={() => change('code', String(code))}
                data-testid={`admin-lock-code-${code}`}
              >
                {code} {label}
              </Button>
            </li>
          ))}
        </ul>
      </details>
      <TextArea
        ref={editRef}
        label={LOCK_FIELD_LABELS.editMessage}
        name="editMessage"
        rows={3}
        required
        maxLength={MAX_LOCK_MESSAGE}
        hint="Shown only to the authors, in the editor. Say exactly what must change before the brew can be unlocked."
        value={draft.editMessage}
        error={errors.editMessage}
        onChange={(event) => change('editMessage', event.target.value)}
        data-testid="admin-lock-edit-input"
      />
      <TextArea
        ref={shareRef}
        label={LOCK_FIELD_LABELS.shareMessage}
        name="shareMessage"
        rows={2}
        required
        maxLength={MAX_LOCK_MESSAGE}
        hint="Shown to everyone who opens the share page, instead of the brew."
        value={draft.shareMessage}
        error={errors.shareMessage}
        onChange={(event) => change('shareMessage', event.target.value)}
        data-testid="admin-lock-share-input"
      />
      <div className={styles.actions}>
        <Button type="submit" variant="danger" icon="lock" loading={lockBrew.isPending} data-testid="admin-lock-submit">
          {relock ? 'Update lock' : 'Lock brew'}
        </Button>
      </div>
    </form>
  );
}
