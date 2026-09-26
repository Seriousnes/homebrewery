// Site notifications under the navbar (port of the idea of legacy
// client/homebrew/brewRenderer/notificationPopup: upstream showed a dialog listing active
// notifications and remembered each dismissKey in localStorage). Here each notice is a banner
// with its own Dismiss button; dismissed keys live in web/src/app/noticeDismissals.ts, so a
// notice stays hidden in this browser. Bodies are plain text (the API guarantees it); no markdown.
import { useLayoutEffect, useRef } from 'react';
import { type NotificationInfo, useActiveNotifications } from '@/api';
import { focusElement, Icon, IconButton } from '@/ui';
import styles from './NotificationBanner.module.css';
import { dismissNotice, NOTICE_REFETCH_MS, useDismissedNotices, visibleNotices } from './noticeDismissals';

export interface NotificationBannerProps {
  /** Where focus goes when the last notice is dismissed (default: nothing moves it). */
  focusAfterLast?: () => void;
}

export function NotificationBanner({ focusAfterLast }: NotificationBannerProps) {
  // The server returns only notices active now; refetching now and then drops expired ones.
  const query = useActiveNotifications({ refetchInterval: NOTICE_REFETCH_MS });
  const dismissed = useDismissedNotices();
  const notices = visibleNotices(query.data ?? [], dismissed);
  const listRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<number | null>(null);

  // After a dismissal, focus moves to the next notice's Dismiss button (or the previous one).
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index == null) return;
    pendingFocus.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLElement>('[data-notice-dismiss]');
    const target = buttons && buttons.length > 0 ? buttons[Math.min(index, buttons.length - 1)] : null;
    if (target) focusElement(target);
    else focusAfterLast?.();
  }, [notices.length, focusAfterLast]);

  if (notices.length === 0) return null;

  const dismiss = (notice: NotificationInfo, index: number) => {
    pendingFocus.current = index;
    dismissNotice(notice.dismissKey);
  };

  return (
    <section className={styles.banner} aria-label="Site notices" data-testid="site-notices">
      <ul ref={listRef} className={styles.list}>
        {notices.map((notice, index) => (
          <li key={notice.id} className={styles.notice} data-testid="site-notice">
            <Icon name="info" size={18} />
            <div className={styles.text}>
              <strong className={styles.title}>{notice.title}</strong>
              {notice.body ? <p className={styles.body}>{notice.body}</p> : null}
            </div>
            <IconButton
              icon="close"
              label={`Dismiss notice: ${notice.title}`}
              tooltip={false}
              size="sm"
              className={styles.dismiss}
              data-notice-dismiss=""
              onClick={() => dismiss(notice, index)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
