// The metadata dialog's model: the brew it describes, the local draft it edits, the save payload
// (SaveBrewRequest.meta) built from that draft, and server validation errors mapped back to fields.
import { isApiError, type AuthorRole, type BrewAuthorInfo, type BrewForEdit, type BrewLockInfo, type BrewMeta, type BrewMetaInput } from '@/api';

/** What the dialog needs to know about the brew (a BrewForEdit, or a draft that was never saved). */
export interface MetadataBrew {
  /** null for a brew that was never saved (/new): nothing to delete or lock. */
  editId: string | null;
  shareId: string | null;
  meta: BrewMeta;
  /** Owner first, then authors and invited users, in display order. */
  authors: readonly BrewAuthorInfo[];
  /** The caller's role; only the owner edits the author list. null = not saved yet (the caller will own it). */
  role: AuthorRole | null;
  lock: BrewLockInfo | null;
}

/** The fields the dialog edits. */
export interface MetaDraft {
  title: string;
  description: string;
  tags: string[];
  lang: string;
  /** A static theme key or a user theme's share id. */
  theme: string;
  published: boolean;
  /** '' = no thumbnail. */
  thumbnailUrl: string;
  /** Owner first; handles the owner adds are 'invited' until they save once. */
  authors: BrewAuthorInfo[];
}

export type MetaField = keyof MetaDraft;

export const META_FIELDS: readonly MetaField[] = ['title', 'description', 'tags', 'lang', 'theme', 'published', 'thumbnailUrl', 'authors'];

/** One accepted edit: the field, the whole draft after it, and the payload to save. */
export interface MetadataChange {
  field: MetaField;
  draft: MetaDraft;
  /** SaveBrewRequest.meta / CreateBrewRequest.meta. */
  meta: BrewMetaInput;
}

export function metadataBrewFrom(brew: BrewForEdit): MetadataBrew {
  return {
    editId: brew.editId,
    shareId: brew.shareId,
    meta: brew.meta,
    authors: brew.authors,
    role: brew.role,
    lock: brew.lock ?? null,
  };
}

export function draftFromBrew(brew: Pick<MetadataBrew, 'meta' | 'authors'>): MetaDraft {
  const { meta } = brew;
  return {
    title: meta.title,
    description: meta.description,
    tags: [...meta.tags],
    lang: meta.lang,
    theme: meta.theme,
    published: meta.published,
    thumbnailUrl: meta.thumbnailUrl ?? '',
    authors: brew.authors.map((a) => ({ handle: a.handle, role: a.role })),
  };
}

export function canManageAuthors(role: AuthorRole | null): boolean {
  return role === 'owner' || role === null;
}

const sameHandles = (a: readonly BrewAuthorInfo[], b: readonly BrewAuthorInfo[]) =>
  a.length === b.length && a.every((author, i) => author.handle === b[i]?.handle);

/**
 * The save payload for `draft`. Every field is sent (the server keeps nothing implicit); `authors`
 * only when the owner changed the list, because the server refuses a changed list from anyone
 * else and an unchanged one needs no work. An empty thumbnail is sent as '' (clears it).
 */
export function metaInputFromDraft(draft: MetaDraft, brew: Pick<MetadataBrew, 'authors' | 'role'>): BrewMetaInput {
  const input: BrewMetaInput = {
    title: draft.title,
    description: draft.description,
    tags: [...draft.tags],
    lang: draft.lang,
    theme: draft.theme,
    published: draft.published,
    thumbnailUrl: draft.thumbnailUrl.trim(),
  };
  if (canManageAuthors(brew.role) && !sameHandles(draft.authors, brew.authors)) input.authors = draft.authors.map((a) => a.handle);
  return input;
}

/** Field errors from a failed save (ValidationProblem keys meta.title, meta.tags, …), plus the rest. */
export interface MetaFieldErrors {
  fields: Partial<Record<MetaField, string>>;
  /** Messages for other meta keys (and 'meta' itself). */
  other: string[];
}

const FIELD_BY_KEY: Record<string, MetaField> = Object.fromEntries(META_FIELDS.map((f) => [f.toLowerCase(), f]));

/** Maps an ApiError's `errors` (400 ValidationProblem) under meta.* to dialog fields. */
export function metaFieldErrors(error: unknown): MetaFieldErrors {
  const result: MetaFieldErrors = { fields: {}, other: [] };
  if (!isApiError(error)) return result;
  for (const [key, messages] of Object.entries(error.errors)) {
    // System.Text.Json binding errors use JSON paths ('$.meta.published').
    const path = key.replace(/^\$\.?/, '').toLowerCase();
    if (path !== 'meta' && !path.startsWith('meta.')) continue;
    const text = messages.join(' ');
    if (!text) continue;
    const field = FIELD_BY_KEY[path.slice('meta.'.length).split(/[.[]/)[0] ?? ''];
    if (field) result.fields[field] = result.fields[field] ? `${result.fields[field]} ${text}` : text;
    else result.other.push(text);
  }
  return result;
}
