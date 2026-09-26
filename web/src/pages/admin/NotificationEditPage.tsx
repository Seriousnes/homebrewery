// /admin/notifications/new and /admin/notifications/:id: the notification form (port of upstream's
// notificationAdd, plus editing) with a live preview of the banner. The API's rules are checked
// before sending; its field messages (400) and a taken dismiss key (409) show on the fields.
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { isApiError, type NotificationInfo } from '@/api';
import { useAdminCreateNotification, useAdminDeleteNotification, useAdminNotification, useAdminUpdateNotification } from '@/api/admin';
import { Button, TextArea, TextField, toast } from '@/ui';
import styles from './Admin.module.css';
import {
  apiFieldErrors,
  localTimeZone,
  MAX_DISMISS_KEY,
  MAX_NOTIFICATION_BODY,
  MAX_NOTIFICATION_TITLE,
  type NotificationDraft,
  notificationDraftFor,
  type NotificationErrors,
  type NotificationField,
  NOTIFICATION_FIELD_LABELS,
  newNotificationDraft,
  validateNotification,
} from './adminModel';
import { Loading, QueryError } from './adminParts';
import { adminPaths } from './adminPaths';
import { AdminSection } from './AdminSection';
import { NotificationPreview } from './NotificationPreview';
import { useConfirmAction } from './useConfirmAction';

const FIELDS: readonly NotificationField[] = ['dismissKey', 'title', 'body', 'startsAt', 'stopsAt'];

export default function NotificationEditPage() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const [deleting, setDeleting] = useState(false);
  const existing = useAdminNotification(isNew ? undefined : id, { enabled: !isNew && !deleting });

  if (isNew) {
    return (
      <AdminSection title="New notification" data-testid="admin-notification-editor">
        <NotificationForm original={null} onDeleting={setDeleting} />
      </AdminSection>
    );
  }
  return (
    <AdminSection title="Edit notification" data-testid="admin-notification-editor">
      {existing.data ? (
        <NotificationForm key={existing.data.id} original={existing.data} onDeleting={setDeleting} />
      ) : existing.error ? (
        existing.error.status === 404 || existing.error.status === 400 ? (
          <p className={styles.empty} data-testid="admin-notification-missing">
            This notification doesn&apos;t exist (any more).{' '}
            <Link className={styles.link} to={adminPaths.notifications}>
              See all notifications
            </Link>
          </p>
        ) : (
          <QueryError error={existing.error} what="the notification" onRetry={() => void existing.refetch()} />
        )
      ) : (
        <Loading>Loading the notification…</Loading>
      )}
    </AdminSection>
  );
}

interface NotificationFormProps {
  original: NotificationInfo | null;
  onDeleting: (deleting: boolean) => void;
}

function NotificationForm({ original, onDeleting }: NotificationFormProps) {
  const navigate = useNavigate();
  const create = useAdminCreateNotification();
  const update = useAdminUpdateNotification();
  const remove = useAdminDeleteNotification();
  const { confirm, dialog } = useConfirmAction();
  const [draft, setDraft] = useState<NotificationDraft>(() => (original ? notificationDraftFor(original) : newNotificationDraft()));
  const [errors, setErrors] = useState<NotificationErrors>({});
  const formId = useId();
  const keyRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const startsRef = useRef<HTMLInputElement>(null);
  const stopsRef = useRef<HTMLInputElement>(null);
  const pending = create.isPending || update.isPending;
  const zone = localTimeZone();
  // The preview's "showing now / scheduled" is judged against the time the form opened.
  const [openedAt] = useState(() => Date.now());

  const showErrors = (found: NotificationErrors) => {
    setErrors(found);
    const first = FIELDS.find((field) => found[field]);
    const target = { dismissKey: keyRef, title: titleRef, body: bodyRef, startsAt: startsRef, stopsAt: stopsRef }[first ?? 'title'];
    if (first) target.current?.focus();
  };

  const change = (field: NotificationField, value: string) => {
    setDraft((old) => ({ ...old, [field]: value }));
    setErrors((old) => (old[field] ? { ...old, [field]: undefined } : old));
  };

  const failed = (error: unknown) => {
    if (isApiError(error) && error.status === 409) {
      showErrors({ dismissKey: error.detail ?? 'Another notification uses this dismiss key.' });
      return;
    }
    const fromApi = apiFieldErrors(error, NOTIFICATION_FIELD_LABELS);
    if (Object.keys(fromApi).length > 0) showErrors(fromApi);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const { errors: found, input } = validateNotification(draft, { original });
    if (!input) {
      showErrors(found);
      return;
    }
    setErrors({});
    const done = (saved: NotificationInfo, verb: string) => {
      toast({ title: `Notification ${verb}`, description: saved.title, tone: 'success' });
      void navigate(adminPaths.notifications);
    };
    if (original) {
      update.mutate({ id: original.id, input }, { onSuccess: (saved) => done(saved, 'saved'), onError: failed });
    } else {
      create.mutate(input, { onSuccess: (saved) => done(saved, 'created'), onError: failed });
    }
  };

  const askDelete = () => {
    if (!original) return;
    confirm({
      title: 'Delete this notification?',
      message: `“${original.title}” (${original.dismissKey}) is removed for good and no longer shown to anyone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
      errorTitle: "Couldn't delete the notification",
      run: async () => {
        // The detail query stops first, so it doesn't ask again for what is being deleted.
        onDeleting(true);
        try {
          await remove.mutateAsync(original.id);
        } catch (error) {
          onDeleting(false);
          throw error;
        }
        toast({ title: 'Notification deleted', description: original.title, tone: 'success' });
        void navigate(adminPaths.notifications);
      },
    });
  };

  return (
    <div className={styles.editorLayout}>
      <form id={formId} className={styles.form} onSubmit={submit} noValidate aria-label={original ? 'Edit the notification' : 'New notification'} data-testid="admin-notification-form">
        <TextField
          ref={keyRef}
          label={NOTIFICATION_FIELD_LABELS.dismissKey}
          name="dismissKey"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={MAX_DISMISS_KEY}
          hint="Unique. A reader who dismisses the notice doesn't see this key again; a new key shows it to everyone again."
          value={draft.dismissKey}
          error={errors.dismissKey}
          onChange={(event) => change('dismissKey', event.target.value)}
          data-testid="admin-notification-key"
        />
        <TextField
          ref={titleRef}
          label={NOTIFICATION_FIELD_LABELS.title}
          name="title"
          autoComplete="off"
          required
          maxLength={MAX_NOTIFICATION_TITLE}
          value={draft.title}
          error={errors.title}
          onChange={(event) => change('title', event.target.value)}
          data-testid="admin-notification-title"
        />
        <TextArea
          ref={bodyRef}
          label={NOTIFICATION_FIELD_LABELS.body}
          name="body"
          rows={5}
          maxLength={MAX_NOTIFICATION_BODY}
          hint="Plain text; line breaks are kept."
          value={draft.body}
          error={errors.body}
          onChange={(event) => change('body', event.target.value)}
          data-testid="admin-notification-body"
        />
        <div className={styles.formRow}>
          <TextField
            ref={startsRef}
            type="datetime-local"
            label={NOTIFICATION_FIELD_LABELS.startsAt}
            name="startsAt"
            hint={`In ${zone}. Empty: now.`}
            value={draft.startsAt}
            error={errors.startsAt}
            onChange={(event) => change('startsAt', event.target.value)}
            data-testid="admin-notification-starts"
          />
          <TextField
            ref={stopsRef}
            type="datetime-local"
            label={NOTIFICATION_FIELD_LABELS.stopsAt}
            name="stopsAt"
            required
            hint={`In ${zone}.`}
            value={draft.stopsAt}
            error={errors.stopsAt}
            onChange={(event) => change('stopsAt', event.target.value)}
            data-testid="admin-notification-stops"
          />
        </div>
        <div className={styles.actions}>
          <Button type="submit" variant="primary" loading={pending} data-testid="admin-notification-save">
            {original ? 'Save changes' : 'Create notification'}
          </Button>
          <Link className={styles.link} to={adminPaths.notifications}>
            Cancel
          </Link>
          {original ? (
            <Button variant="danger" icon="trash" onClick={askDelete} className={styles.pushEnd} data-testid="admin-notification-delete">
              Delete
            </Button>
          ) : null}
        </div>
      </form>
      <NotificationPreview draft={draft} now={openedAt} />
      {dialog}
    </div>
  );
}
