import { describe, expect, it } from 'vitest';
import { ApiError, type NotificationInfo } from '@/api';
import {
  apiFieldErrors,
  DEFAULT_LOCK_CODE,
  DEFAULT_SHARE_MESSAGE,
  formatCount,
  fromDateTimeLocal,
  isLockedOut,
  LOCK_CODES,
  LOCK_FIELD_LABELS,
  lockCodeText,
  lockDraftFor,
  newNotificationDraft,
  NOTIFICATION_FIELD_LABELS,
  notificationDraftFor,
  notificationStatus,
  toDateTimeLocal,
  validateLock,
  validateNotification,
  yesNo,
} from './adminModel';

describe('lock helpers', () => {
  it("prefill upstream's defaults for an unlocked brew and the stored values for a locked one", () => {
    expect(DEFAULT_LOCK_CODE).toBe(455);
    expect(lockDraftFor(null)).toEqual({ code: '455', editMessage: '', shareMessage: DEFAULT_SHARE_MESSAGE });
    expect(lockDraftFor(undefined).code).toBe('455');
    expect(
      lockDraftFor({ code: 463, editMessage: 'Credit the source.', shareMessage: 'Locked.', applied: '2026-09-01T10:00:00Z', reviewRequested: null }),
    ).toEqual({ code: '463', editMessage: 'Credit the source.', shareMessage: 'Locked.' });
  });

  it("name upstream's suggested codes", () => {
    expect(LOCK_CODES.map((entry) => entry.code)).toEqual([455, 456, 457, 458, 459, 460, 461, 462, 463, 465, 466]);
    expect(lockCodeText(455)).toBe('455 Generic lock');
    expect(lockCodeText(456)).toBe('456 Copyright issues');
    expect(lockCodeText(123)).toBe('123');
  });

  it('accept a valid lock and trim the messages', () => {
    expect(validateLock({ code: ' 455 ', editMessage: '  Fix page 3. ', shareMessage: ' Locked. ' })).toEqual({
      errors: {},
      request: { code: 455, editMessage: 'Fix page 3.', shareMessage: 'Locked.' },
    });
    expect(validateLock({ code: '100', editMessage: 'a', shareMessage: 'b' }).request?.code).toBe(100);
    expect(validateLock({ code: '999', editMessage: 'a', shareMessage: 'b' }).request?.code).toBe(999);
  });

  it.each([
    ['', 'Enter a lock code.'],
    ['   ', 'Enter a lock code.'],
    ['99', 'The lock code is a number from 100 to 999.'],
    ['1000', 'The lock code is a number from 100 to 999.'],
    ['45a', 'The lock code is a number from 100 to 999.'],
    ['4.5e2', 'The lock code is a number from 100 to 999.'],
    ['-455', 'The lock code is a number from 100 to 999.'],
  ])('refuse the code %j', (code, message) => {
    const result = validateLock({ code, editMessage: 'a', shareMessage: 'b' });
    expect(result.request).toBeNull();
    expect(result.errors).toEqual({ code: message });
  });

  it('require both messages, at most 1000 characters each', () => {
    expect(validateLock({ code: '455', editMessage: ' ', shareMessage: '' }).errors).toEqual({
      editMessage: 'Tell the authors what to change before the brew can be unlocked.',
      shareMessage: 'Enter the message readers see instead of the brew.',
    });
    const long = 'x'.repeat(1001);
    expect(validateLock({ code: '455', editMessage: long, shareMessage: long }).errors).toEqual({
      editMessage: 'At most 1000 characters (now 1001).',
      shareMessage: 'At most 1000 characters (now 1001).',
    });
    expect(validateLock({ code: '455', editMessage: 'x'.repeat(1000), shareMessage: ` ${'y'.repeat(1000)} ` }).request).not.toBeNull();
  });
});

describe('datetime-local conversion', () => {
  it('round-trips a local time with minute precision', () => {
    const date = new Date(2026, 8, 25, 14, 5, 42);
    expect(toDateTimeLocal(date)).toBe('2026-09-25T14:05');
    expect(fromDateTimeLocal('2026-09-25T14:05')?.getTime()).toBe(new Date(2026, 8, 25, 14, 5).getTime());
    expect(fromDateTimeLocal('2026-09-25T14:05:30')?.getTime()).toBe(new Date(2026, 8, 25, 14, 5, 30).getTime());
    expect(toDateTimeLocal(date.toISOString())).toBe('2026-09-25T14:05');
    expect(toDateTimeLocal(date.getTime())).toBe('2026-09-25T14:05');
  });

  it('refuses empty, malformed and overflowing values', () => {
    expect(toDateTimeLocal('')).toBe('');
    expect(toDateTimeLocal(null)).toBe('');
    expect(toDateTimeLocal('not a date')).toBe('');
    expect(fromDateTimeLocal('')).toBeNull();
    expect(fromDateTimeLocal('2026-09-25')).toBeNull();
    expect(fromDateTimeLocal('2026-02-31T10:00')).toBeNull();
    expect(fromDateTimeLocal('2026-09-25T25:00')).toBeNull();
  });
});

describe('notification helpers', () => {
  const now = new Date(2026, 8, 25, 12, 0);

  it('start a new notification now, ending in a week', () => {
    expect(newNotificationDraft(now)).toEqual({ dismissKey: '', title: '', body: '', startsAt: '2026-09-25T12:00', stopsAt: '2026-10-02T12:00' });
  });

  it('turn a valid form into the API input', () => {
    const { errors, input } = validateNotification(
      { dismissKey: ' maintenance-1 ', title: ' Maintenance ', body: ' Down at noon.\nBack soon. ', startsAt: '2026-09-26T10:00', stopsAt: '2026-09-27T10:00' },
      { now },
    );
    expect(errors).toEqual({});
    expect(input).toEqual({
      dismissKey: 'maintenance-1',
      title: 'Maintenance',
      body: 'Down at noon.\nBack soon.',
      startsAt: new Date(2026, 8, 26, 10, 0).toISOString(),
      stopsAt: new Date(2026, 8, 27, 10, 0).toISOString(),
    });
  });

  it('send no start when the field is empty (the server starts it now)', () => {
    const { input } = validateNotification({ dismissKey: 'k', title: 't', body: '', startsAt: '', stopsAt: '2026-09-26T10:00' }, { now });
    expect(input?.startsAt).toBeNull();
    expect(input?.body).toBe('');
  });

  it('report every problem on its field', () => {
    expect(validateNotification({ dismissKey: '', title: ' ', body: 'x'.repeat(10_001), startsAt: 'nope', stopsAt: '' }, { now }).errors).toEqual({
      dismissKey: 'Enter a dismiss key.',
      title: 'Enter a title.',
      body: 'At most 10000 characters (now 10001).',
      startsAt: 'Enter a valid date and time, or leave it empty to start now.',
      stopsAt: 'Enter when the notification ends.',
    });
    expect(
      validateNotification({ dismissKey: 'k'.repeat(101), title: 't'.repeat(201), body: '', startsAt: '', stopsAt: 'bad' }, { now }).errors,
    ).toEqual({
      dismissKey: 'At most 100 characters (now 101).',
      title: 'At most 200 characters (now 201).',
      stopsAt: 'Enter a valid date and time.',
    });
  });

  it('require the end after the start (or after now when it starts now)', () => {
    const base = { dismissKey: 'k', title: 't', body: '' };
    expect(validateNotification({ ...base, startsAt: '2026-09-26T10:00', stopsAt: '2026-09-26T10:00' }, { now }).errors).toEqual({
      stopsAt: 'The end must be after the start.',
    });
    expect(validateNotification({ ...base, startsAt: '', stopsAt: '2026-09-25T11:00' }, { now }).errors).toEqual({
      stopsAt: 'The end must be in the future.',
    });
  });

  it('keep stored times the admin did not touch (the field shows only minutes)', () => {
    const original: NotificationInfo = {
      id: 'n1',
      dismissKey: 'k',
      title: 't',
      body: '',
      startsAt: new Date(2026, 8, 20, 9, 30, 15, 250).toISOString(),
      stopsAt: new Date(2026, 8, 30, 9, 30, 45).toISOString(),
      createdAt: new Date(2026, 8, 20, 9, 0).toISOString(),
    };
    const draft = notificationDraftFor(original);
    expect(draft.startsAt).toBe('2026-09-20T09:30');
    const kept = validateNotification({ ...draft, title: 'new title' }, { now, original });
    expect(kept.input?.startsAt).toBe(original.startsAt);
    expect(kept.input?.stopsAt).toBe(original.stopsAt);
    const changed = validateNotification({ ...draft, stopsAt: '2026-10-01T09:30' }, { now, original });
    expect(changed.input?.startsAt).toBe(original.startsAt);
    expect(changed.input?.stopsAt).toBe(new Date(2026, 9, 1, 9, 30).toISOString());
  });

  it('say whether a notification shows now, later or no more', () => {
    const t = (h: number) => new Date(2026, 8, 25, h).toISOString();
    const at = now.getTime();
    expect(notificationStatus({ startsAt: t(10), stopsAt: t(14) }, at)).toBe('active');
    expect(notificationStatus({ startsAt: t(12), stopsAt: t(14) }, at)).toBe('active');
    expect(notificationStatus({ startsAt: t(13), stopsAt: t(14) }, at)).toBe('scheduled');
    expect(notificationStatus({ startsAt: t(10), stopsAt: t(12) }, at)).toBe('ended');
  });
});

describe('API field errors', () => {
  const problem = (errors: Record<string, string[]>) =>
    new ApiError({ kind: 'http', status: 400, title: 'One or more validation errors occurred.', errors, method: 'POST', url: '/api/admin/notifications' });

  it('turn field messages into sentences with the field labels', () => {
    const error = problem({ title: ['is required'], stopsAt: ['must be after startsAt'], other: ['ignored'] });
    expect(apiFieldErrors(error, NOTIFICATION_FIELD_LABELS)).toEqual({
      title: 'Title is required.',
      stopsAt: 'End time must be after the start time.',
    });
    expect(apiFieldErrors(problem({ code: ['Lock codes are 100-999.'] }), LOCK_FIELD_LABELS)).toEqual({ code: 'Lock codes are 100-999.' });
  });

  it('ignore anything else', () => {
    expect(apiFieldErrors(new Error('boom'), LOCK_FIELD_LABELS)).toEqual({});
    expect(apiFieldErrors(new ApiError({ kind: 'http', status: 500, title: 'Server error' }), LOCK_FIELD_LABELS)).toEqual({});
  });
});

describe('formatting', () => {
  it('formats counts, yes/no and lockouts', () => {
    expect(formatCount(1234)).toBe(new Intl.NumberFormat().format(1234));
    expect(yesNo(true)).toBe('Yes');
    expect(yesNo(false)).toBe('No');
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(isLockedOut(null, now)).toBe(false);
    expect(isLockedOut('2026-09-25T11:00:00Z', now)).toBe(false);
    expect(isLockedOut('2026-09-25T13:00:00Z', now)).toBe(true);
    expect(isLockedOut('garbage', now)).toBe(false);
  });
});
