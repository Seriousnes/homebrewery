// Uploading local brews to the signed-in user's account (issue #4): POST /api/brews with the
// brew's document, CSS, snippets, metadata (unpublished) and import text. The Idempotency-Key is
// derived from the local id and the time of its last change (SAVE-8): a retried upload of the same
// content is answered with the brew the first one created instead of making a second (the API
// answers 422 to a reused key with another body, so an edit since then needs a key of its own).
// The local copy is removed once the cloud has it.
import { ApiError, type ApiClient, type BrewForEdit, createBrew, type CreateBrewRequest, describeApiError } from '@/api';
import { activeLocalEditor } from './activeEditors';
import { defaultLocalBrews, type LocalBrew, type LocalBrewLibrary } from './localBrews';

/** The Idempotency-Key of a local brew's upload (at most 128 characters: the API's limit). */
export const uploadKey = (brew: Pick<LocalBrew, 'id' | 'updatedAt'>): string => `local-brew-${brew.id}-${Math.trunc(brew.updatedAt).toString(36)}`;

/** The create request of a local brew (published: false; publishing is the author's next step). */
export function uploadRequest(brew: LocalBrew): CreateBrewRequest {
  const { title, description, tags, lang, theme } = brew.meta;
  return {
    doc: brew.doc,
    docSchemaVersion: brew.docSchemaVersion,
    style: brew.style,
    snippets: brew.snippets ?? null,
    meta: { title, description, tags, lang, theme, published: false },
    ...(brew.sourceMarkdown ? { sourceMarkdown: brew.sourceMarkdown } : {}),
  };
}

export interface UploadOptions {
  library?: LocalBrewLibrary;
  client?: ApiClient;
  signal?: AbortSignal;
}

/**
 * Uploads local brew `id` and removes it from this device. Returns the created brew. An editor that
 * has the brew open in this tab stores its changes and stops writing first (activeEditors.ts), and
 * is told the outcome. Throws an Error when the brew is gone (another tab uploaded or deleted it) or
 * the open editor couldn't store it, or the API error.
 */
export async function uploadLocalBrew(id: string, { library = defaultLocalBrews(), client, signal }: UploadOptions = {}): Promise<BrewForEdit> {
  const editor = activeLocalEditor(id);
  if (editor && !(await editor.prepareUpload())) throw new Error('The open brew couldn’t be saved on this device first. Try again.');
  try {
    const brew = await library.get(id);
    if (!brew) throw new Error('This brew is no longer on this device.');
    const created = await createBrew(uploadRequest(brew), { client, signal, idempotencyKey: uploadKey(brew) });
    await library.remove(id);
    editor?.uploaded(created);
    return created;
  } catch (error) {
    editor?.uploadFailed();
    throw error;
  }
}

export interface UploadAllResult {
  uploaded: BrewForEdit[];
  /** Local ids that failed, with the error (they stay on this device). */
  failed: { id: string; error: unknown }[];
}

/** Uploads the brews one at a time (the API's write limit is per client), newest first. */
export async function uploadLocalBrews(ids: readonly string[], options: UploadOptions = {}): Promise<UploadAllResult> {
  const result: UploadAllResult = { uploaded: [], failed: [] };
  for (const id of ids) {
    options.signal?.throwIfAborted();
    try {
      result.uploaded.push(await uploadLocalBrew(id, options));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      result.failed.push({ id, error });
    }
  }
  return result;
}

/** The message for a failed upload. */
export function uploadProblem(error: unknown): string {
  if (error instanceof ApiError) return describeApiError(error);
  return error instanceof Error ? error.message : String(error);
}
