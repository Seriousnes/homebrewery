// Wording for the save status (SaveStatus.tsx, the toolbar) and time formatting.
import { describeApiError } from '@/api';
import type { IconName } from '@/ui';
import type { AutosaveState } from './autosave';

export type StatusTone = 'neutral' | 'busy' | 'warning' | 'error';

export interface StatusInfo {
  /** Short visible label. */
  label: string;
  /** Longer explanation (tooltip, announcement). */
  description: string;
  icon: IconName;
  tone: StatusTone;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "14:02" today, else "25 Sep 2026, 14:02". */
export function formatSavedAt(time: number, now: number = Date.now()): string {
  const date = new Date(time);
  return new Date(now).toDateString() === date.toDateString() ? timeFormat.format(date) : dateTimeFormat.format(date);
}

/** "just now", "5 minutes ago", "yesterday", … */
export function formatRelative(time: number, now: number = Date.now()): string {
  const seconds = Math.round((time - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 45 * 60) return relativeFormat.format(Math.round(seconds / 60), 'minute');
  if (abs < 22 * 3600) return relativeFormat.format(Math.round(seconds / 3600), 'hour');
  return relativeFormat.format(Math.round(seconds / 86400), 'day');
}

export function saveStatusInfo(state: Pick<AutosaveState, 'status' | 'editId' | 'lastSavedAt' | 'error' | 'retryAt'>, now: number = Date.now()): StatusInfo {
  switch (state.status) {
    case 'saved':
      if (state.editId === null && state.lastSavedAt === null) {
        return { label: 'Not saved yet', description: 'This brew is saved once you start writing.', icon: 'unsaved', tone: 'neutral' };
      }
      return {
        label: 'Saved',
        description: state.lastSavedAt ? `All changes saved (${formatSavedAt(state.lastSavedAt, now)}).` : 'All changes saved.',
        icon: 'saved',
        tone: 'neutral',
      };
    case 'dirty':
      return { label: 'Unsaved changes', description: 'Changes are saved automatically a few seconds after you stop typing.', icon: 'unsaved', tone: 'neutral' };
    case 'saving':
      return { label: 'Saving…', description: 'Saving your changes.', icon: 'saving', tone: 'busy' };
    case 'offline':
      return {
        label: 'Offline',
        description: 'Can’t reach the server. Your changes are kept on this device and saved when the connection is back.',
        icon: 'saveError',
        tone: 'warning',
      };
    case 'signedOut':
      return {
        label: 'Not saved',
        description: 'Sign in to save. Your changes are kept on this device until then.',
        icon: 'lock',
        tone: 'warning',
      };
    case 'conflict':
      return {
        label: 'Conflict',
        description: 'This brew was saved somewhere else. Autosave is paused until you choose which version to keep.',
        icon: 'warning',
        tone: 'error',
      };
    case 'error':
      return {
        label: 'Couldn’t save',
        description: `${state.error ? describeApiError(state.error) : 'Something went wrong.'} Your changes are kept on this device.`,
        icon: 'saveError',
        tone: 'error',
      };
    case 'lost':
      return {
        label: 'Can’t save here',
        description: `${state.error ? describeApiError(state.error) : 'This brew can’t be saved any more.'} It may have been deleted, or you are no longer one of its authors. Save your version as a new brew to keep it.`,
        icon: 'saveError',
        tone: 'error',
      };
  }
}
