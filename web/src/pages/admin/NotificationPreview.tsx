// A live preview of a site notice as the shell's NotificationBanner shows it under the navbar (it
// reuses the banner's own CSS module, so the preview follows its styles). Not a landmark and not
// interactive: the dismiss button is drawn, not rendered as a control.
import bannerStyles from '@/app/NotificationBanner.module.css';
import { Icon } from '@/ui';
import styles from './Admin.module.css';
import { fromDateTimeLocal, type NotificationDraft, notificationStatus, NOTIFICATION_STATUS_TEXT } from './adminModel';
import { Time } from './adminParts';

export function NotificationPreview({ draft, now }: { draft: NotificationDraft; now: number }) {
  const title = draft.title.trim();
  const body = draft.body.trim();
  const start = draft.startsAt.trim() ? fromDateTimeLocal(draft.startsAt) : new Date(now);
  const stop = fromDateTimeLocal(draft.stopsAt);
  const valid = start && stop && stop.getTime() > start.getTime();
  const status = valid ? notificationStatus({ startsAt: start.toISOString(), stopsAt: stop.toISOString() }, now) : null;

  return (
    <figure className={styles.preview} data-testid="admin-notification-preview">
      <figcaption className={styles.previewCaption}>Preview</figcaption>
      <div className={styles.previewFrame}>
        <div className={bannerStyles.banner}>
          <ul className={bannerStyles.list}>
            <li className={bannerStyles.notice}>
              <Icon name="info" size={18} />
              <div className={bannerStyles.text}>
                <strong className={bannerStyles.title} data-testid="admin-preview-title">
                  {title || <span className={styles.previewEmpty}>The title goes here</span>}
                </strong>
                {body ? (
                  <p className={bannerStyles.body} data-testid="admin-preview-body">
                    {body}
                  </p>
                ) : null}
              </div>
              <span className={styles.previewClose} aria-hidden="true">
                <Icon name="close" size={14} />
              </span>
            </li>
          </ul>
        </div>
      </div>
      <p className={`${styles.small} ${styles.muted}`} data-testid="admin-preview-when">
        {valid && start && stop ? (
          <>
            {status ? `${NOTIFICATION_STATUS_TEXT[status]}. ` : null}
            Shown from <Time value={start.toISOString()} /> until <Time value={stop.toISOString()} /> to everyone who hasn&apos;t dismissed it.
          </>
        ) : (
          'Set when the notice starts and ends.'
        )}
      </p>
    </figure>
  );
}
