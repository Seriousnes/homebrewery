// Pure helpers of the brew item: the wording of its delete/leave/decline action (DELETE
// /api/brews/{editId} removes the caller; the brew is deleted only when no owner or author is
// left), counts, and the "Download" file (the stored brew as JSON).
import type { BrewForEdit, BrewSummary } from '@/api';
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

// ─── Download ───────────────────────────────────────────────────────────────────────────────────

/** The downloaded file's format marker (a brew as stored: document JSON, style, snippets, meta). */
export const BREW_FILE_FORMAT = 'homebrewery-brew';
export const BREW_FILE_VERSION = 1;

/** A file name from a title: characters Windows and macOS refuse are dropped; at most 80 characters. */
export function fileNameFor(title: string, extension: string): string {
  const base = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 80)
    .trim();
  return `${base || 'brew'}.${extension}`;
}

/**
 * The stored brew as a JSON file (upstream's "download" gave the brew's markdown source; the
 * source of a brew here is its document JSON). An imported brew also carries its original
 * markdown (sourceMarkdown).
 */
export function brewFile(brew: BrewForEdit, exportedAt: Date = new Date()): { name: string; text: string } {
  const file = {
    format: BREW_FILE_FORMAT,
    formatVersion: BREW_FILE_VERSION,
    exportedAt: exportedAt.toISOString(),
    shareId: brew.shareId,
    docSchemaVersion: brew.docSchemaVersion,
    version: brew.version,
    createdAt: brew.createdAt,
    updatedAt: brew.updatedAt,
    meta: brew.meta,
    authors: brew.authors.filter((a) => a.role !== 'invited').map((a) => a.handle),
    style: brew.style,
    snippets: brew.snippets ?? null,
    doc: brew.doc,
    sourceMarkdown: brew.sourceMarkdown ?? null,
  };
  return { name: fileNameFor(displayTitle(brew.meta), 'json'), text: `${JSON.stringify(file, null, 2)}\n` };
}

/** Hands `text` to the browser as a download (an object URL and a temporary link). */
export function saveTextFile(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Firefox needs the URL a little while after the click.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
