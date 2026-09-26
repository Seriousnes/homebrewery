// /admin/locks: the review queue (locked brews whose authors asked for a review, oldest first) and
// every locked brew (most recently locked first), with Dismiss review and Unlock per row (port of
// upstream's lockTools tables). A row's title opens the brew's page with the full lock tools.
import { type RefObject, useEffect, useId, useRef } from 'react';
import { Link, useLocation } from 'react-router';
import type { LockedBrewInfo } from '@/api';
import { useAdminDismissReview, useAdminLocks, useAdminReviewQueue, useAdminStats, useAdminUnlockBrew } from '@/api/admin';
import { Button, toast } from '@/ui';
import styles from './Admin.module.css';
import { formatCount, lockCodeText } from './adminModel';
import { Loading, Pill, QueryError, TableRegion, Time } from './adminParts';
import { adminPaths, REVIEW_QUEUE_ANCHOR } from './adminPaths';
import { AdminSection } from './AdminSection';
import { useConfirmAction } from './useConfirmAction';

export default function LocksPage() {
  const queue = useAdminReviewQueue();
  const locks = useAdminLocks();
  // The totals behind the navigation's review badge (same query as AdminNav).
  const stats = useAdminStats();
  const unlock = useAdminUnlockBrew();
  const dismiss = useAdminDismissReview();
  const { confirm, dialog } = useConfirmAction();
  const queueHeading = useRef<HTMLHeadingElement>(null);
  const locksHeading = useRef<HTMLHeadingElement>(null);
  const location = useLocation();

  // /admin/locks#review-queue (the overview's link): bring the queue into view and focus it.
  useEffect(() => {
    if (location.hash !== `#${REVIEW_QUEUE_ANCHOR}`) return;
    const heading = queueHeading.current;
    if (!heading) return;
    // Optional call: jsdom has no scrollIntoView.
    heading.scrollIntoView?.({ block: 'start' });
    heading.focus({ preventScroll: true });
  }, [location.hash, location.key]);

  const askUnlock = (brew: LockedBrewInfo, heading: RefObject<HTMLHeadingElement | null>) =>
    confirm({
      title: 'Unlock this brew?',
      message: `“${brew.title || 'Untitled brew'}” becomes readable on its share page again, and its authors no longer see the lock message.`,
      confirmLabel: 'Unlock',
      tone: 'danger',
      errorTitle: "Couldn't unlock the brew",
      run: async () => {
        await unlock.mutateAsync(brew.shareId);
        toast({ title: 'Brew unlocked', description: brew.title || 'Untitled brew', tone: 'success' });
      },
      focusAfter: () => heading.current,
    });

  const askDismiss = (brew: LockedBrewInfo, heading: RefObject<HTMLHeadingElement | null>) =>
    confirm({
      title: 'Dismiss the review request?',
      message: `“${brew.title || 'Untitled brew'}” stays locked. Its authors can ask for a review again.`,
      confirmLabel: 'Dismiss request',
      tone: 'danger',
      errorTitle: "Couldn't dismiss the review request",
      run: async () => {
        await dismiss.mutateAsync(brew.shareId);
        toast({ title: 'Review request dismissed', description: brew.title || 'Untitled brew', tone: 'success' });
      },
      focusAfter: () => heading.current,
    });

  const refreshing = queue.isFetching || locks.isFetching;

  return (
    <AdminSection title="Locks" lead="Locked brews and the authors' review requests. Open a brew to change its lock." data-testid="admin-locks">
      <div className={`${styles.actions} ${styles.pageActions}`}>
        <Button
          size="sm"
          loading={refreshing}
          onClick={() => {
            void queue.refetch();
            void locks.refetch();
            void stats.refetch();
          }}
          data-testid="admin-locks-refresh"
        >
          Refresh
        </Button>
        <Link className={styles.link} to={adminPaths.brews}>
          Lock a brew
        </Link>
      </div>

      <LockTable
        id={REVIEW_QUEUE_ANCHOR}
        title="Review queue"
        description="Locked brews whose authors changed them and asked for a review, oldest request first. Unlock the brew, or dismiss the request to keep it locked."
        empty="No brews are awaiting review."
        headingRef={queueHeading}
        query={queue}
        what="the review queue"
        showReview
        onUnlock={(brew) => askUnlock(brew, queueHeading)}
        onDismiss={(brew) => askDismiss(brew, queueHeading)}
        data-testid="admin-review-queue"
      />
      <LockTable
        title="Locked brews"
        description="Every locked brew, most recently locked first."
        empty="No brews are locked."
        headingRef={locksHeading}
        query={locks}
        what="the locked brews"
        onUnlock={(brew) => askUnlock(brew, locksHeading)}
        onDismiss={(brew) => askDismiss(brew, locksHeading)}
        data-testid="admin-locked-brews"
      />
      {dialog}
    </AdminSection>
  );
}

interface LockTableProps {
  id?: string;
  title: string;
  description: string;
  empty: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  query: { data?: LockedBrewInfo[]; error: unknown; refetch: () => Promise<unknown> };
  what: string;
  /** The queue: the request time is its own column. */
  showReview?: boolean;
  onUnlock: (brew: LockedBrewInfo) => void;
  onDismiss: (brew: LockedBrewInfo) => void;
  'data-testid': string;
}

function LockTable({ id, title, description, empty, headingRef, query, what, showReview = false, onUnlock, onDismiss, 'data-testid': testId }: LockTableProps) {
  const headingId = useId();
  const rows = query.data;
  return (
    <section className={styles.card} aria-labelledby={headingId} data-testid={testId}>
      <div className={styles.cardHeader}>
        <h2 id={id} ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
          <span id={headingId}>{title}</span>
          {rows ? <span className={styles.muted}> ({formatCount(rows.length)})</span> : null}
        </h2>
      </div>
      <p className={`${styles.text} ${styles.muted}`}>{description}</p>
      {rows ? (
        rows.length === 0 ? (
          <p className={styles.empty} data-testid={`${testId}-empty`}>
            {empty}
          </p>
        ) : (
          <TableRegion caption={title} hideCaption data-testid={`${testId}-table`}>
            <thead>
              <tr>
                <th scope="col">Brew</th>
                <th scope="col">Authors</th>
                <th scope="col">Code</th>
                <th scope="col">Locked</th>
                <th scope="col">Review</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((brew) => {
                const name = brew.title || 'Untitled brew';
                return (
                  <tr key={brew.shareId} data-testid="admin-lock-row" data-share-id={brew.shareId}>
                    <th scope="row">
                      <Link className={styles.link} to={adminPaths.brew(brew.shareId)}>
                        {name}
                      </Link>
                      <div className={`${styles.small} ${styles.muted} ${styles.mono}`}>{brew.shareId}</div>
                    </th>
                    <td>
                      {brew.authors.length === 0
                        ? '—'
                        : brew.authors.map((handle, index) => (
                            <span key={handle}>
                              {index > 0 ? ', ' : null}
                              <Link className={styles.link} to={adminPaths.user(handle)}>
                                {handle}
                              </Link>
                            </span>
                          ))}
                    </td>
                    <td>{lockCodeText(brew.lock.code)}</td>
                    <td className={styles.nowrap}>
                      <Time value={brew.lock.applied} relative />
                    </td>
                    <td className={styles.nowrap}>
                      {brew.lock.reviewRequested ? (
                        <Pill tone="warning">
                          Requested <Time value={brew.lock.reviewRequested} relative />
                        </Pill>
                      ) : showReview ? (
                        '—'
                      ) : (
                        'Not requested'
                      )}
                    </td>
                    <td>
                      <span className={styles.cellActions}>
                        {brew.lock.reviewRequested ? (
                          <Button size="sm" aria-label={`Dismiss request for ${name}`} onClick={() => onDismiss(brew)} data-testid="admin-row-dismiss">
                            Dismiss request
                          </Button>
                        ) : null}
                        <Button size="sm" variant="danger" aria-label={`Unlock ${name}`} onClick={() => onUnlock(brew)} data-testid="admin-row-unlock">
                          Unlock
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableRegion>
        )
      ) : query.error ? (
        <QueryError error={query.error} what={what} onRetry={() => void query.refetch()} />
      ) : (
        <Loading>Loading {what}…</Loading>
      )}
    </section>
  );
}
