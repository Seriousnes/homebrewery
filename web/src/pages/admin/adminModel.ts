// Pure helpers for the admin pages (P7.4): lock codes and defaults (ported from upstream's
// legacy/client/admin/lockTools), lock and notification form validation (the API's rules, checked
// before sending), datetime-local conversion, notification status, and API field messages.
import { type AdminLockInfo, isApiError, type LockRequest, type NotificationInfo, type NotificationInput } from '@/api';

// ─── Locks ──────────────────────────────────────────────────────────────────────────────────────

/** Upstream's lock tool prefilled this code ("Generic lock"). */
export const DEFAULT_LOCK_CODE = 455;
export const MIN_LOCK_CODE = 100;
export const MAX_LOCK_CODE = 999;
/** Both lock messages: required, at most this many characters (AdminService.MaxLockMessage). */
export const MAX_LOCK_MESSAGE = 1000;
/** Upstream's default public message. */
export const DEFAULT_SHARE_MESSAGE = 'This Brew has been locked.';

/** Upstream's suggested codes (legacy lockTools "Suggestions"). */
export const LOCK_CODES: readonly { code: number; label: string }[] = [
  { code: 455, label: 'Generic lock' },
  { code: 456, label: 'Copyright issues' },
  { code: 457, label: 'Confidential information leakage' },
  { code: 458, label: 'Sensitive personal information' },
  { code: 459, label: 'Defamation or libel' },
  { code: 460, label: 'Hate speech or discrimination' },
  { code: 461, label: 'Illegal activities' },
  { code: 462, label: 'Malware or phishing' },
  { code: 463, label: 'Plagiarism' },
  { code: 465, label: 'Misrepresentation' },
  { code: 466, label: 'Inappropriate content' },
];

/** "455 Generic lock", or just the number for a code without a suggestion. */
export function lockCodeText(code: number): string {
  const known = LOCK_CODES.find((entry) => entry.code === code);
  return known ? `${code} ${known.label}` : String(code);
}

export type LockField = 'code' | 'editMessage' | 'shareMessage';
export type LockErrors = Partial<Record<LockField, string>>;

/** The lock form's values (strings, as typed). */
export interface LockDraft {
  code: string;
  editMessage: string;
  shareMessage: string;
}

/** The form for a brew: its current lock's values, else upstream's defaults (455, the default share message). */
export function lockDraftFor(lock: AdminLockInfo | null | undefined): LockDraft {
  return lock
    ? { code: String(lock.code), editMessage: lock.editMessage, shareMessage: lock.shareMessage }
    : { code: String(DEFAULT_LOCK_CODE), editMessage: '', shareMessage: DEFAULT_SHARE_MESSAGE };
}

export const LOCK_FIELD_LABELS: Record<LockField, string> = {
  code: 'Lock code',
  editMessage: 'Message to the authors',
  shareMessage: 'Message to readers',
};

/** The API's rules (code 100-999; both messages required, at most 1000 characters after trimming). */
export function validateLock(draft: LockDraft): { errors: LockErrors; request: LockRequest | null } {
  const errors: LockErrors = {};
  const codeText = draft.code.trim();
  const code = /^\d{1,4}$/.test(codeText) ? Number(codeText) : Number.NaN;
  if (!codeText) errors.code = 'Enter a lock code.';
  else if (!Number.isInteger(code) || code < MIN_LOCK_CODE || code > MAX_LOCK_CODE) {
    errors.code = `The lock code is a number from ${MIN_LOCK_CODE} to ${MAX_LOCK_CODE}.`;
  }
  const editMessage = draft.editMessage.trim();
  const shareMessage = draft.shareMessage.trim();
  if (!editMessage) errors.editMessage = 'Tell the authors what to change before the brew can be unlocked.';
  else if (editMessage.length > MAX_LOCK_MESSAGE) errors.editMessage = `At most ${MAX_LOCK_MESSAGE} characters (now ${editMessage.length}).`;
  if (!shareMessage) errors.shareMessage = 'Enter the message readers see instead of the brew.';
  else if (shareMessage.length > MAX_LOCK_MESSAGE) errors.shareMessage = `At most ${MAX_LOCK_MESSAGE} characters (now ${shareMessage.length}).`;
  if (Object.keys(errors).length > 0) return { errors, request: null };
  return { errors, request: { code, editMessage, shareMessage } };
}

// ─── Notifications ──────────────────────────────────────────────────────────────────────────────

/** NotificationService limits. */
export const MAX_DISMISS_KEY = 100;
export const MAX_NOTIFICATION_TITLE = 200;
export const MAX_NOTIFICATION_BODY = 10_000;
/** A new notification runs for a week unless the admin says otherwise. */
export const DEFAULT_NOTIFICATION_DAYS = 7;

export type NotificationField = 'dismissKey' | 'title' | 'body' | 'startsAt' | 'stopsAt';
export type NotificationErrors = Partial<Record<NotificationField, string>>;

/** The notification form's values; the times are datetime-local strings in this browser's time zone. */
export interface NotificationDraft {
  dismissKey: string;
  title: string;
  body: string;
  startsAt: string;
  stopsAt: string;
}

export const NOTIFICATION_FIELD_LABELS: Record<NotificationField, string> = {
  dismissKey: 'Dismiss key',
  title: 'Title',
  body: 'Message',
  startsAt: 'Start time',
  stopsAt: 'End time',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** A datetime-local value ('2026-09-25T14:05') for a time, in this browser's time zone; '' when invalid. */
export function toDateTimeLocal(time: string | number | Date | null | undefined): string {
  if (time == null || time === '') return '';
  const date = time instanceof Date ? time : new Date(time);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The time a datetime-local value names (local time zone), or null when it is empty or invalid. */
export function fromDateTimeLocal(value: string): Date | null {
  const match = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0', ms = '0'] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms.padEnd(3, '0')));
  // Reject overflow such as February 31st (Date would roll it into March).
  if (date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d) || date.getHours() !== Number(h)) return null;
  return date;
}

/** A blank form: starts now, ends in a week. */
export function newNotificationDraft(now: Date = new Date()): NotificationDraft {
  const stop = new Date(now.getTime());
  stop.setDate(stop.getDate() + DEFAULT_NOTIFICATION_DAYS);
  return { dismissKey: '', title: '', body: '', startsAt: toDateTimeLocal(now), stopsAt: toDateTimeLocal(stop) };
}

export function notificationDraftFor(info: NotificationInfo): NotificationDraft {
  return {
    dismissKey: info.dismissKey,
    title: info.title,
    body: info.body,
    startsAt: toDateTimeLocal(info.startsAt),
    stopsAt: toDateTimeLocal(info.stopsAt),
  };
}

/**
 * The API's rules, checked before sending. An empty start means "now" (the server's default). When
 * `original` is given and a time field still shows the stored value, the stored time is sent
 * unchanged (the field only shows minutes).
 */
export function validateNotification(
  draft: NotificationDraft,
  { now = new Date(), original }: { now?: Date; original?: NotificationInfo | null } = {},
): { errors: NotificationErrors; input: NotificationInput | null } {
  const errors: NotificationErrors = {};
  const dismissKey = draft.dismissKey.trim();
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (!dismissKey) errors.dismissKey = 'Enter a dismiss key.';
  else if (dismissKey.length > MAX_DISMISS_KEY) errors.dismissKey = `At most ${MAX_DISMISS_KEY} characters (now ${dismissKey.length}).`;
  if (!title) errors.title = 'Enter a title.';
  else if (title.length > MAX_NOTIFICATION_TITLE) errors.title = `At most ${MAX_NOTIFICATION_TITLE} characters (now ${title.length}).`;
  if (body.length > MAX_NOTIFICATION_BODY) errors.body = `At most ${MAX_NOTIFICATION_BODY} characters (now ${body.length}).`;

  const keep = (field: 'startsAt' | 'stopsAt'): string | null =>
    original && draft[field] === toDateTimeLocal(original[field]) ? original[field] : null;

  let startsAt: string | null = null;
  let start = now;
  if (draft.startsAt.trim()) {
    const parsed = fromDateTimeLocal(draft.startsAt);
    if (!parsed) errors.startsAt = 'Enter a valid date and time, or leave it empty to start now.';
    else {
      startsAt = keep('startsAt') ?? parsed.toISOString();
      start = new Date(startsAt);
    }
  }
  let stopsAt: string | null = null;
  if (!draft.stopsAt.trim()) errors.stopsAt = 'Enter when the notification ends.';
  else {
    const parsed = fromDateTimeLocal(draft.stopsAt);
    if (!parsed) errors.stopsAt = 'Enter a valid date and time.';
    else {
      stopsAt = keep('stopsAt') ?? parsed.toISOString();
      if (!errors.startsAt && new Date(stopsAt).getTime() <= start.getTime()) {
        errors.stopsAt = startsAt ? 'The end must be after the start.' : 'The end must be in the future.';
      }
    }
  }
  if (Object.keys(errors).length > 0) return { errors, input: null };
  return { errors, input: { dismissKey, title, body, startsAt, stopsAt } };
}

export type NotificationStatus = 'active' | 'scheduled' | 'ended';

/** Active from startsAt (inclusive) until stopsAt (exclusive), like GET /api/notifications/active. */
export function notificationStatus(info: Pick<NotificationInfo, 'startsAt' | 'stopsAt'>, now: number = Date.now()): NotificationStatus {
  const start = Date.parse(info.startsAt);
  const stop = Date.parse(info.stopsAt);
  if (Number.isFinite(stop) && now >= stop) return 'ended';
  if (Number.isFinite(start) && now < start) return 'scheduled';
  return 'active';
}

export const NOTIFICATION_STATUS_TEXT: Record<NotificationStatus, string> = {
  active: 'Showing now',
  scheduled: 'Scheduled',
  ended: 'Ended',
};

/** This browser's time zone name (for form hints), e.g. 'Europe/Berlin'. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your time zone';
  } catch {
    return 'your time zone';
  }
}

// ─── API field errors ───────────────────────────────────────────────────────────────────────────

/**
 * The API's field messages (400 ValidationProblem `errors`) for the given fields, as sentences:
 * 'is required' on 'title' becomes 'Title is required.'; field names inside a message are replaced
 * by their labels. Other keys are ignored.
 */
export function apiFieldErrors<F extends string>(error: unknown, labels: Record<F, string>): Partial<Record<F, string>> {
  const out: Partial<Record<F, string>> = {};
  if (!isApiError(error) || !error.hasFieldErrors) return out;
  for (const field of Object.keys(labels) as F[]) {
    const message = error.fieldError(field);
    if (message) out[field] = sentence(message, field, labels);
  }
  return out;
}

function sentence<F extends string>(message: string, field: F, labels: Record<F, string>): string {
  let text = message.trim();
  for (const [key, label] of Object.entries(labels) as [F, string][]) {
    text = text.replace(new RegExp(`\\b${key}\\b`, 'g'), `the ${label.toLowerCase()}`);
  }
  if (/^[a-z]/.test(text)) text = `${labels[field]} ${text}`;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// ─── Formatting ─────────────────────────────────────────────────────────────────────────────────

const counts = new Intl.NumberFormat();

/** 1234 → '1,234' (locale grouping). */
export function formatCount(value: number): string {
  return counts.format(value);
}

/** 'Yes' / 'No'. */
export const yesNo = (value: boolean): string => (value ? 'Yes' : 'No');

/** The user search's result cap (AdminService.MaxUserResults). */
export const MAX_USER_RESULTS = 50;

/** Whether Identity's lockout (failed sign-ins) blocks the account at `now`. */
export function isLockedOut(lockoutEnd: string | null | undefined, now: number): boolean {
  if (!lockoutEnd) return false;
  const end = Date.parse(lockoutEnd);
  return Number.isFinite(end) && end > now;
}
