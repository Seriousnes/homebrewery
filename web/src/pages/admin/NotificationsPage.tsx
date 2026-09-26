// /admin/notifications: every site notification (newest start first) with its state, Edit and
// Delete (port of upstream's notificationLookup; "Add notification" is /admin/notifications/new).
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAdminDeleteNotification, useAdminNotifications } from '@/api/admin';
import { Button, Icon, toast } from '@/ui';
import styles from './Admin.module.css';
import { NOTIFICATION_STATUS_TEXT, notificationStatus, type NotificationStatus } from './adminModel';
import { Loading, Pill, type PillTone, QueryError, TableRegion, Time } from './adminParts';
import { adminPaths } from './adminPaths';
import { AdminSection } from './AdminSection';
import { useConfirmAction } from './useConfirmAction';

const STATUS_TONE: Record<NotificationStatus, PillTone> = { active: 'success', scheduled: 'info', ended: 'neutral' };

export default function NotificationsPage() {
  const list = useAdminNotifications();
  const remove = useAdminDeleteNotification();
  const { confirm, dialog } = useConfirmAction();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  // The state column is computed once per load of the page (not re-rendered by the clock).
  const [now] = useState(() => Date.now());

  return (
    <AdminSection
      title="Notifications"
      lead="Site notices shown under the navbar between their start and end times. Readers can dismiss each one."
      data-testid="admin-notifications"
    >
      <div className={`${styles.actions} ${styles.pageActions}`}>
        <Link className={styles.linkButton} to={adminPaths.newNotification} data-testid="admin-notification-new">
          <Icon name="plus" size={16} />
          New notification
        </Link>
      </div>
      <section className={styles.card} aria-labelledby={headingId}>
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
          All notifications
        </h2>
        {list.data ? (
          list.data.length === 0 ? (
            <p className={styles.empty} data-testid="admin-notifications-empty">
              There are no notifications.
            </p>
          ) : (
            <TableRegion caption="All notifications" hideCaption data-testid="admin-notifications-table">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Dismiss key</th>
                  <th scope="col">State</th>
                  <th scope="col">Starts</th>
                  <th scope="col">Ends</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((notification) => {
                  const status = notificationStatus(notification, now);
                  return (
                    <tr key={notification.id} data-testid="admin-notification-row" data-dismiss-key={notification.dismissKey}>
                      <th scope="row">
                        <Link className={styles.link} to={adminPaths.notification(notification.id)}>
                          {notification.title}
                        </Link>
                      </th>
                      <td className={styles.mono}>{notification.dismissKey}</td>
                      <td>
                        <Pill tone={STATUS_TONE[status]}>{NOTIFICATION_STATUS_TEXT[status]}</Pill>
                      </td>
                      <td className={styles.nowrap}>
                        <Time value={notification.startsAt} />
                      </td>
                      <td className={styles.nowrap}>
                        <Time value={notification.stopsAt} />
                      </td>
                      <td>
                        <span className={styles.cellActions}>
                          <Link
                            className={styles.rowLink}
                            to={adminPaths.notification(notification.id)}
                            aria-label={`Edit ${notification.title}`}
                            data-testid="admin-notification-edit"
                          >
                            Edit
                          </Link>
                          <Button
                            size="sm"
                            variant="danger"
                            icon="trash"
                            aria-label={`Delete ${notification.title}`}
                            data-testid="admin-notification-delete"
                            onClick={() =>
                              confirm({
                                title: 'Delete this notification?',
                                message: `“${notification.title}” (${notification.dismissKey}) is removed for good and no longer shown to anyone.`,
                                confirmLabel: 'Delete',
                                tone: 'danger',
                                errorTitle: "Couldn't delete the notification",
                                run: async () => {
                                  await remove.mutateAsync(notification.id);
                                  toast({ title: 'Notification deleted', description: notification.title, tone: 'success' });
                                },
                                focusAfter: () => headingRef.current,
                              })
                            }
                          >
                            Delete
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableRegion>
          )
        ) : list.error ? (
          <QueryError error={list.error} what="the notifications" onRetry={() => void list.refetch()} />
        ) : (
          <Loading>Loading the notifications…</Loading>
        )}
      </section>
      {dialog}
    </AdminSection>
  );
}
