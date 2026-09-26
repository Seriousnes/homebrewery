// Brew endpoints (plan §8.3, §8.4): load for edit or share, create, save, delete, clone, and the
// author's lock review request. Create and save bodies are gzip-compressed when large.
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CallOptions, unwrap } from './client';
import type { ApiError } from './errors';
import { type GzipMode, jsonBodyOptions } from './gzip';
import { mergeMutationOptions, type MutationOverrides, type QueryOverrides } from './hookOptions';
import { mutationKeys, queryKeys } from './keys';
import type {
  BrewForEdit,
  BrewForShare,
  BrewLockInfo,
  BrewMeta,
  CreateBrewRequest,
  DeleteBrewResponse,
  SaveBrewRequest,
  SaveBrewResponse,
} from './types';

export interface BodyCallOptions extends CallOptions {
  /** Default 'auto': gzip bodies of GZIP_MIN_BYTES (8 KiB) or more. */
  gzip?: GzipMode;
}

export interface SaveCallOptions extends BodyCallOptions {
  /**
   * fetch keepalive (for a save on visibilitychange → hidden or pagehide). Browsers refuse
   * keepalive bodies over 64 KiB, which then fail as a network error.
   */
  keepalive?: boolean;
}

// ─── Calls ──────────────────────────────────────────────────────────────────────────────────────

/** Full brew for its authors. 401 anonymous, 403 not an author, 404 unknown. */
export async function fetchBrewForEdit(editId: string, { client = api, signal }: CallOptions = {}): Promise<BrewForEdit> {
  return unwrap(client.GET('/api/brews/edit/{editId}', { params: { path: { editId } }, signal }), {
    method: 'GET',
    url: `/api/brews/edit/${editId}`,
  });
}

/** Read-only brew. Counts a view unless the caller is an author. 404, or 423 with lock detail and code. */
export async function fetchBrewForShare(shareId: string, { client = api, signal }: CallOptions = {}): Promise<BrewForShare> {
  return unwrap(client.GET('/api/brews/share/{shareId}', { params: { path: { shareId } }, signal }), {
    method: 'GET',
    url: `/api/brews/share/${shareId}`,
  });
}

/**
 * Create a brew (the caller becomes owner). The returned doc is the sanitized one: use it.
 * `idempotencyKey` (SAVE-8, header Idempotency-Key): the same key and body sent again within 24 h
 * answers 201 with the brew the first request created; the same key with another body is 422.
 */
export async function createBrew(
  body: CreateBrewRequest,
  { client = api, signal, gzip, idempotencyKey }: BodyCallOptions & { idempotencyKey?: string } = {},
): Promise<BrewForEdit> {
  const { bodySerializer, headers } = jsonBodyOptions(body, { gzip });
  const sent = idempotencyKey ? { ...headers, 'Idempotency-Key': idempotencyKey } : headers;
  return unwrap(client.POST('/api/brews', { body, bodySerializer, headers: sent, signal }), { method: 'POST', url: '/api/brews' });
}

/**
 * Save with optimistic concurrency. 409 → ApiError with serverVersion (the caller handles it);
 * 400 → ApiError.errors keyed by document path.
 */
export async function saveBrew(
  editId: string,
  body: SaveBrewRequest,
  { client = api, signal, gzip, keepalive }: SaveCallOptions = {},
): Promise<SaveBrewResponse> {
  const { bodySerializer, headers } = jsonBodyOptions(body, { gzip });
  return unwrap(
    client.PUT('/api/brews/{editId}', {
      params: { path: { editId } },
      body,
      bodySerializer,
      headers,
      signal,
      ...(keepalive ? { keepalive: true } : {}),
    }),
    { method: 'PUT', url: `/api/brews/${editId}` },
  );
}

/** Remove the caller as author; the brew is deleted when no owner or author remains. */
export async function deleteBrew(editId: string, { client = api, signal }: CallOptions = {}): Promise<DeleteBrewResponse> {
  return unwrap(client.DELETE('/api/brews/{editId}', { params: { path: { editId } }, signal }), {
    method: 'DELETE',
    url: `/api/brews/${editId}`,
  });
}

/** Copy a brew into a new one owned by the caller. 404, 423 when locked. */
export async function cloneBrew(shareId: string, { client = api, signal }: CallOptions = {}): Promise<BrewForEdit> {
  return unwrap(client.POST('/api/brews/{shareId}/clone', { params: { path: { shareId } }, signal }), {
    method: 'POST',
    url: `/api/brews/${shareId}/clone`,
  });
}

/** Ask the moderators to review this brew's lock. 409 when it is not locked. */
export async function requestLockReview(editId: string, { client = api, signal }: CallOptions = {}): Promise<BrewLockInfo> {
  return unwrap(client.POST('/api/brews/{editId}/lock/review', { params: { path: { editId } }, signal }), {
    method: 'POST',
    url: `/api/brews/${editId}/lock/review`,
  });
}

// ─── Queries ────────────────────────────────────────────────────────────────────────────────────

export const brewQueries = {
  /**
   * The editor's load-once source: never refetched on its own (staleTime Infinity, no focus or
   * reconnect refetch) and dropped as soon as no editor uses it (gcTime 0), so a later visit always
   * loads the stored version. useSaveBrew keeps version and meta in step while it is mounted.
   */
  edit: (editId: string) =>
    queryOptions<BrewForEdit, ApiError>({
      queryKey: queryKeys.brews.edit(editId),
      queryFn: ({ signal }) => fetchBrewForEdit(editId, { signal }),
      staleTime: Infinity,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
  /**
   * Every fetch counts a view for non-authors, so it is fetched once per visit: never refetched
   * while the page is open (staleTime Infinity), and dropped when the page goes (gcTime 0), so the
   * next visit shows the brew as it is then (e.g. after the author edited it).
   * No abort signal: a request cancelled when its page unmounts (React StrictMode's remount, a
   * quick navigation) has already counted its view, and the remount would count another one; the
   * one request in flight is reused instead (a query is not collected while it fetches).
   */
  share: (shareId: string) =>
    queryOptions<BrewForShare, ApiError>({
      queryKey: queryKeys.brews.share(shareId),
      queryFn: () => fetchBrewForShare(shareId),
      staleTime: Infinity,
      gcTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
};

export function useBrewForEdit(editId: string | undefined, overrides?: QueryOverrides<BrewForEdit>) {
  return useQuery({ ...brewQueries.edit(editId ?? ''), enabled: Boolean(editId), ...overrides });
}

export function useBrewForShare(shareId: string | undefined, overrides?: QueryOverrides<BrewForShare>) {
  return useQuery({ ...brewQueries.share(shareId ?? ''), enabled: Boolean(shareId), ...overrides });
}

// ─── Mutations ──────────────────────────────────────────────────────────────────────────────────

/** Create a brew; the result seeds the edit cache so /edit/:editId opens without another request. */
export function useCreateBrew(overrides?: MutationOverrides<BrewForEdit, CreateBrewRequest>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<BrewForEdit, CreateBrewRequest, unknown>(
      {
        mutationKey: mutationKeys.createBrew,
        mutationFn: (body) => createBrew(body),
        meta: { errorTitle: "Couldn't create the brew" },
        onSuccess: async (brew) => {
          queryClient.setQueryData(queryKeys.brews.edit(brew.editId), brew);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
            queryClient.invalidateQueries({ queryKey: queryKeys.themes.all }),
          ]);
        },
      },
      overrides,
    ),
  );
}

export interface SaveBrewVariables {
  body: SaveBrewRequest;
  options?: Omit<SaveCallOptions, 'client' | 'signal'>;
}

/** Meta fields a save request set (null/undefined keep the stored value). */
function savedMeta(meta: SaveBrewRequest['meta'], stored: BrewMeta): BrewMeta {
  if (!meta) return stored;
  return {
    title: meta.title ?? stored.title,
    description: meta.description ?? stored.description,
    tags: meta.tags ?? stored.tags,
    lang: meta.lang ?? stored.lang,
    theme: meta.theme ?? stored.theme,
    published: meta.published ?? stored.published,
    thumbnailUrl: meta.thumbnailUrl == null ? stored.thumbnailUrl : meta.thumbnailUrl || null,
  };
}

/**
 * Save the brew. Errors: 409 (conflict, ApiError.serverVersion) and 400 (field errors) are the
 * caller's; 401 raises the sign-in prompt; others toast. Autosave passes meta { errorPolicy:
 * 'manual' } when it shows its own status. On success the cached BrewForEdit takes the saved doc,
 * style, snippets, meta and the new version, so the cache matches what the server stored.
 */
export function useSaveBrew(editId: string, overrides?: MutationOverrides<SaveBrewResponse, SaveBrewVariables>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<SaveBrewResponse, SaveBrewVariables, unknown>(
      {
        mutationKey: mutationKeys.saveBrew(editId),
        mutationFn: ({ body, options }) => saveBrew(editId, body, options),
        meta: { errorTitle: "Couldn't save the brew" },
        onSuccess: async (saved, { body }) => {
          queryClient.setQueryData<BrewForEdit>(queryKeys.brews.edit(editId), (old) =>
            old
              ? {
                  ...old,
                  version: saved.version,
                  updatedAt: saved.updatedAt,
                  pageCount: saved.pageCount,
                  authors: saved.authors,
                  doc: body.doc,
                  style: body.style ?? '',
                  snippets: body.snippets ?? null,
                  meta: { ...savedMeta(body.meta, old.meta), title: saved.title },
                }
              : old,
          );
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
            queryClient.invalidateQueries({ queryKey: queryKeys.vault.all }),
          ]);
        },
      },
      overrides,
    ),
  );
}

/** Leave (or delete) a brew by edit id. */
export function useDeleteBrew(overrides?: MutationOverrides<DeleteBrewResponse, string>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<DeleteBrewResponse, string, unknown>(
      {
        mutationKey: mutationKeys.deleteBrew,
        mutationFn: (editId) => deleteBrew(editId),
        meta: { errorTitle: "Couldn't delete the brew" },
        onSuccess: async (_result, editId) => {
          queryClient.removeQueries({ queryKey: queryKeys.brews.edit(editId) });
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
            queryClient.invalidateQueries({ queryKey: queryKeys.vault.all }),
            queryClient.invalidateQueries({ queryKey: queryKeys.themes.all }),
          ]);
        },
      },
      overrides,
    ),
  );
}

/** Clone by share id; the copy seeds the edit cache. */
export function useCloneBrew(overrides?: MutationOverrides<BrewForEdit, string>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<BrewForEdit, string, unknown>(
      {
        mutationKey: mutationKeys.cloneBrew,
        mutationFn: (shareId) => cloneBrew(shareId),
        meta: { errorTitle: "Couldn't copy the brew" },
        onSuccess: async (brew) => {
          queryClient.setQueryData(queryKeys.brews.edit(brew.editId), brew);
          await queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
        },
      },
      overrides,
    ),
  );
}

/** Request a lock review by edit id; the cached BrewForEdit gets the updated lock. */
export function useRequestLockReview(overrides?: MutationOverrides<BrewLockInfo, string>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<BrewLockInfo, string, unknown>(
      {
        mutationKey: mutationKeys.requestLockReview,
        mutationFn: (editId) => requestLockReview(editId),
        meta: { errorTitle: "Couldn't request a review" },
        onSuccess: (lock, editId) => {
          queryClient.setQueryData<BrewForEdit>(queryKeys.brews.edit(editId), (old) => (old ? { ...old, lock } : old));
        },
      },
      overrides,
    ),
  );
}
