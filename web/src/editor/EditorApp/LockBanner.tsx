// The lock banner of the editor (plan §8.3 locks, P7.4): an admin locked the brew. Its share page
// is hidden until then; the authors see the lock's edit message here and can ask for a review
// once they have fixed it (POST /api/brews/{editId}/lock/review). Saving still works.
import { useId, useState } from 'react';
import { type BrewLockInfo, classifyApiError, describeApiError, isApiError, useRequestLockReview } from '@/api';
import { formatDateTime, formatRelativeTime } from '@/app/relativeTime';
import { Button, Icon, toast } from '@/ui';
import styles from './EditorApp.module.css';

export interface LockBannerProps {
  lock: BrewLockInfo;
  /** The brew to request a review for (null before its first save: no review possible). */
  editId: string | null;
  /** After a review request: the updated lock, or null when the brew turned out not to be locked any more. */
  onLockChange?: (lock: BrewLockInfo | null) => void;
}

export function LockBanner({ lock, editId, onLockChange }: LockBannerProps) {
  const titleId = useId();
  // Failures the error policy leaves to the caller (409, 400): said here. Others toast (policy).
  const [error, setError] = useState<string | null>(null);
  const review = useRequestLockReview({
    onMutate: () => setError(null),
    onSuccess: (next) => onLockChange?.(next),
    onError: (failure) => {
      if (classifyApiError(failure) !== 'caller') return;
      if (isApiError(failure) && failure.status === 409) {
        // An admin removed the lock meanwhile: the banner goes.
        toast({ title: 'This brew is no longer locked', description: failure.detail ?? undefined, tone: 'info' });
        onLockChange?.(null);
        return;
      }
      setError(`Couldn't request a review. ${describeApiError(failure)}`);
    },
  });
  const requested = lock.reviewRequested;

  return (
    <section className={styles.lock} aria-labelledby={titleId} data-testid="lock-banner">
      <Icon name="lock" size={20} className={styles.lockIcon} />
      <div className={styles.lockText}>
        <h2 id={titleId} className={styles.lockTitle}>
          This brew is locked
        </h2>
        <p className={styles.lockMessage} data-testid="lock-message">
          {lock.message || 'No reason was given.'}
        </p>
        <p className={styles.lockMeta}>
          Lock code {lock.code} · locked {formatRelativeTime(lock.applied)}. Its share page stays hidden until the lock is removed; you can
          still edit and save.
        </p>
      </div>
      {requested ? (
        <p className={styles.lockMeta} role="status" data-testid="lock-review-requested">
          Review requested <time dateTime={requested}>{formatDateTime(requested)}</time>
        </p>
      ) : editId ? (
        <Button
          size="sm"
          variant="primary"
          loading={review.isPending}
          onClick={() => review.mutate(editId)}
          data-testid="lock-request-review"
        >
          Request review
        </Button>
      ) : null}
      {error ? (
        <p className={styles.lockError} role="alert" data-testid="lock-review-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
