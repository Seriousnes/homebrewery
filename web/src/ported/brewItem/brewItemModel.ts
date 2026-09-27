// Pure helpers of the brew item: the wording of its delete/leave/decline action (DELETE
// /api/brews/{editId} removes the caller; the brew is deleted only when no owner or author is
// left) and counts.
import type { BrewSummary } from '@/api';
import { displayTitle, formatCount } from '@/ported/listPage/listModel';

export interface RemoveCopy {
  /** The item's button ("Delete", "Remove", "Decline"). */
  label: string;
  /** The confirm dialog's title and message. */
  title: string;
  message: string;
  confirmLabel: string;
  /** The toast after the request succeeded. */
  done: (brewDeleted: boolean) => string;
}

/**
 * Upstream asked twice ("Are you REALLY sure?") and worded it by author count; here one
 * confirmation says exactly what happens for the caller's role.
 */
export function removeCopy(brew: Pick<BrewSummary, 'title' | 'authors' | 'role'>): RemoveCopy {
  const title = `“${displayTitle(brew)}”`;
  if (brew.role === 'invited') {
    return {
      label: 'Decline',
      title: `Decline the invitation to ${title}?`,
      message: "You won't be able to edit this brew unless its owner invites you again.",
      confirmLabel: 'Decline invitation',
      done: () => `You declined the invitation to ${title}.`,
    };
  }
  if (brew.authors.length <= 1) {
    return {
      label: 'Delete',
      title: `Delete ${title}?`,
      message: "You are its only author, so the brew is deleted for good and its share link stops working. This can't be undone.",
      confirmLabel: 'Delete brew',
      done: (deleted) => (deleted ? `${title} was deleted.` : `You are no longer an author of ${title}.`),
    };
  }
  return {
    label: 'Remove',
    title: `Remove ${title} from your brews?`,
    message:
      brew.role === 'owner'
        ? 'You stop being one of its authors and the next author becomes its owner. The other authors keep the brew.'
        : 'You stop being one of its authors. The other authors keep the brew.',
    confirmLabel: 'Remove me',
    done: (deleted) => (deleted ? `${title} was deleted.` : `You are no longer an author of ${title}.`),
  };
}

export const viewCount = (n: number): string => `${formatCount(n)} ${n === 1 ? 'view' : 'views'}`;
export const pageCount = (n: number): string => `${formatCount(n)} ${n === 1 ? 'page' : 'pages'}`;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** "12 Mar 2026" in the reader's locale ('' for an invalid date). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? dateFormat.format(d) : '';
}
