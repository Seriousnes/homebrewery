// Admin endpoints (P2.7, P7.4): stats, user lookup, brew lookup, locks and the review queue, and
// site notifications. All need the Admin role (401 anonymous, 403 others).
import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type CallOptions, unwrap } from './client';
import type { ApiError } from './errors';
import { mergeMutationOptions, type MutationOverrides, type QueryOverrides } from './hookOptions';
import { mutationKeys, normalizeHandle, queryKeys } from './keys';
import type {
  AdminBrewInfo,
  AdminStats,
  AdminUserInfo,
  LockedBrewInfo,
  LockRequest,
  NotificationInfo,
  NotificationInput,
  UserBrewList,
} from './types';

/**
 * Keys of the admin lane's own queries (web/src/api/keys.ts belongs to the foundation lane). They
 * sit under queryKeys.admin.all, so dropping the admin caches (sign-out) covers them too.
 */
export const adminKeys = {
  /** Prefix of every admin user-brews list. */
  userBrewLists: ['admin', 'user-brews'] as const,
  /** GET /api/admin/users/{handle}/brews; handles are case-insensitive. */
  userBrews: (handle: string) => ['admin', 'user-brews', normalizeHandle(handle)] as const,
};

// ─── Calls ──────────────────────────────────────────────────────────────────────────────────────

export async function fetchAdminStats({ client = api, signal }: CallOptions = {}): Promise<AdminStats> {
  return unwrap(client.GET('/api/admin/stats', { signal }), { method: 'GET', url: '/api/admin/stats' });
}

/** Accounts whose handle or email contains q (or whose id is q); at most 50. 400 when q is empty. */
export async function findAdminUsers(q: string, { client = api, signal }: CallOptions = {}): Promise<AdminUserInfo[]> {
  return unwrap(client.GET('/api/admin/users', { params: { query: { q: q.trim() } }, signal }), {
    method: 'GET',
    url: '/api/admin/users',
  });
}

/**
 * Every brew of an account as the account itself sees them (unpublished, locked and invited ones,
 * with edit ids and roles). 404 'User not found'.
 */
export async function fetchAdminUserBrews(handle: string, { client = api, signal }: CallOptions = {}): Promise<UserBrewList> {
  const normalized = normalizeHandle(handle);
  return unwrap(client.GET('/api/admin/users/{handle}/brews', { params: { path: { handle: normalized } }, signal }), {
    method: 'GET',
    url: `/api/admin/users/${normalized}/brews`,
  });
}

/** A brew by internal id, share id or edit id. 404 otherwise. */
export async function fetchAdminBrew(id: string, { client = api, signal }: CallOptions = {}): Promise<AdminBrewInfo> {
  const trimmed = id.trim();
  return unwrap(client.GET('/api/admin/brews/{id}', { params: { path: { id: trimmed } }, signal }), {
    method: 'GET',
    url: `/api/admin/brews/${trimmed}`,
  });
}

/** Locked brews, most recently locked first. */
export async function fetchAdminLocks({ client = api, signal }: CallOptions = {}): Promise<LockedBrewInfo[]> {
  return unwrap(client.GET('/api/admin/locks', { signal }), { method: 'GET', url: '/api/admin/locks' });
}

/** Locked brews whose authors asked for a review, oldest request first. */
export async function fetchAdminReviewQueue({ client = api, signal }: CallOptions = {}): Promise<LockedBrewInfo[]> {
  return unwrap(client.GET('/api/admin/locks/review-queue', { signal }), { method: 'GET', url: '/api/admin/locks/review-queue' });
}

/** Lock (or relock) a brew; clears any review request. Code 100-999, both messages required. */
export async function lockBrew(shareId: string, body: LockRequest, { client = api, signal }: CallOptions = {}): Promise<AdminBrewInfo> {
  return unwrap(client.PUT('/api/admin/brews/{shareId}/lock', { params: { path: { shareId } }, body, signal }), {
    method: 'PUT',
    url: `/api/admin/brews/${shareId}/lock`,
  });
}

/** Remove a lock (idempotent). */
export async function unlockBrew(shareId: string, { client = api, signal }: CallOptions = {}): Promise<AdminBrewInfo> {
  return unwrap(client.DELETE('/api/admin/brews/{shareId}/lock', { params: { path: { shareId } }, signal }), {
    method: 'DELETE',
    url: `/api/admin/brews/${shareId}/lock`,
  });
}

/** Dismiss a review request; the brew stays locked. 409 when not locked. */
export async function dismissLockReview(shareId: string, { client = api, signal }: CallOptions = {}): Promise<AdminBrewInfo> {
  return unwrap(client.DELETE('/api/admin/brews/{shareId}/lock/review', { params: { path: { shareId } }, signal }), {
    method: 'DELETE',
    url: `/api/admin/brews/${shareId}/lock/review`,
  });
}

export async function fetchAdminNotifications({ client = api, signal }: CallOptions = {}): Promise<NotificationInfo[]> {
  return unwrap(client.GET('/api/admin/notifications', { signal }), { method: 'GET', url: '/api/admin/notifications' });
}

export async function fetchAdminNotification(id: string, { client = api, signal }: CallOptions = {}): Promise<NotificationInfo> {
  return unwrap(client.GET('/api/admin/notifications/{id}', { params: { path: { id } }, signal }), {
    method: 'GET',
    url: `/api/admin/notifications/${id}`,
  });
}

/** 400 errors.{dismissKey|title|body|stopsAt}; 409 'Dismiss key taken'. */
export async function createNotification(body: NotificationInput, { client = api, signal }: CallOptions = {}): Promise<NotificationInfo> {
  return unwrap(client.POST('/api/admin/notifications', { body, signal }), { method: 'POST', url: '/api/admin/notifications' });
}

export async function updateNotification(
  id: string,
  body: NotificationInput,
  { client = api, signal }: CallOptions = {},
): Promise<NotificationInfo> {
  return unwrap(client.PUT('/api/admin/notifications/{id}', { params: { path: { id } }, body, signal }), {
    method: 'PUT',
    url: `/api/admin/notifications/${id}`,
  });
}

export async function deleteNotification(id: string, { client = api, signal }: CallOptions = {}): Promise<void> {
  await unwrap(client.DELETE('/api/admin/notifications/{id}', { params: { path: { id } }, signal }), {
    method: 'DELETE',
    url: `/api/admin/notifications/${id}`,
  });
}

// ─── Queries ────────────────────────────────────────────────────────────────────────────────────

export const adminQueries = {
  stats: () =>
    queryOptions<AdminStats, ApiError>({ queryKey: queryKeys.admin.stats(), queryFn: ({ signal }) => fetchAdminStats({ signal }) }),
  users: (q: string) =>
    queryOptions<AdminUserInfo[], ApiError>({
      queryKey: queryKeys.admin.users(q),
      queryFn: ({ signal }) => findAdminUsers(q, { signal }),
    }),
  userBrews: (handle: string) =>
    queryOptions<UserBrewList, ApiError>({
      queryKey: adminKeys.userBrews(handle),
      queryFn: ({ signal }) => fetchAdminUserBrews(handle, { signal }),
    }),
  brew: (id: string) =>
    queryOptions<AdminBrewInfo, ApiError>({
      queryKey: queryKeys.admin.brew(id),
      queryFn: ({ signal }) => fetchAdminBrew(id, { signal }),
    }),
  locks: () =>
    queryOptions<LockedBrewInfo[], ApiError>({ queryKey: queryKeys.admin.locks(), queryFn: ({ signal }) => fetchAdminLocks({ signal }) }),
  reviewQueue: () =>
    queryOptions<LockedBrewInfo[], ApiError>({
      queryKey: queryKeys.admin.reviewQueue(),
      queryFn: ({ signal }) => fetchAdminReviewQueue({ signal }),
    }),
  notifications: () =>
    queryOptions<NotificationInfo[], ApiError>({
      queryKey: queryKeys.admin.notificationList(),
      queryFn: ({ signal }) => fetchAdminNotifications({ signal }),
    }),
  notification: (id: string) =>
    queryOptions<NotificationInfo, ApiError>({
      queryKey: queryKeys.admin.notification(id),
      queryFn: ({ signal }) => fetchAdminNotification(id, { signal }),
    }),
};

export function useAdminStats(overrides?: QueryOverrides<AdminStats>) {
  return useQuery({ ...adminQueries.stats(), ...overrides });
}

/** Disabled until q has text (the server answers 400 for an empty q). */
export function useAdminUsers(q: string, overrides?: QueryOverrides<AdminUserInfo[]>) {
  return useQuery({ ...adminQueries.users(q), enabled: q.trim() !== '', ...overrides });
}

/** Disabled until handle has text. A 404 ('User not found') gets no toast (the policy's error-page class). */
export function useAdminUserBrews(handle: string | undefined, overrides?: QueryOverrides<UserBrewList>) {
  return useQuery({ ...adminQueries.userBrews(handle ?? ''), enabled: Boolean(handle?.trim()), ...overrides });
}

/** A 404 here is a normal lookup result, so errors are left to the caller. */
export function useAdminBrew(id: string | undefined, overrides?: QueryOverrides<AdminBrewInfo>) {
  return useQuery({
    ...adminQueries.brew(id ?? ''),
    enabled: Boolean(id?.trim()),
    retry: false,
    meta: { errorPolicy: 'manual' },
    ...overrides,
  });
}

export function useAdminLocks(overrides?: QueryOverrides<LockedBrewInfo[]>) {
  return useQuery({ ...adminQueries.locks(), ...overrides });
}

export function useAdminReviewQueue(overrides?: QueryOverrides<LockedBrewInfo[]>) {
  return useQuery({ ...adminQueries.reviewQueue(), ...overrides });
}

export function useAdminNotifications(overrides?: QueryOverrides<NotificationInfo[]>) {
  return useQuery({ ...adminQueries.notifications(), ...overrides });
}

export function useAdminNotification(id: string | undefined, overrides?: QueryOverrides<NotificationInfo>) {
  return useQuery({ ...adminQueries.notification(id ?? ''), enabled: Boolean(id), ...overrides });
}

// ─── Mutations ──────────────────────────────────────────────────────────────────────────────────

/**
 * After a lock change: the brew lookups, lock lists, stats, the admin user-brews lists (their
 * `locked` flags) and that brew's share view. Lists no page shows are fetched again when a page
 * shows them next.
 */
async function afterLockChange(queryClient: QueryClient, brew: AdminBrewInfo): Promise<void> {
  queryClient.setQueryData(queryKeys.admin.brew(brew.shareId), brew);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.brews }),
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.locks() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.stats() }),
    queryClient.invalidateQueries({ queryKey: adminKeys.userBrewLists }),
    queryClient.invalidateQueries({ queryKey: queryKeys.brews.share(brew.shareId) }),
  ]);
}

export interface LockBrewVariables {
  shareId: string;
  lock: LockRequest;
}

export function useAdminLockBrew(overrides?: MutationOverrides<AdminBrewInfo, LockBrewVariables>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<AdminBrewInfo, LockBrewVariables, unknown>(
      {
        mutationKey: mutationKeys.admin.lock,
        mutationFn: ({ shareId, lock }) => lockBrew(shareId, lock),
        meta: { errorTitle: "Couldn't lock the brew" },
        onSuccess: (brew) => afterLockChange(queryClient, brew),
      },
      overrides,
    ),
  );
}

/** Variables: the share id. */
export function useAdminUnlockBrew(overrides?: MutationOverrides<AdminBrewInfo, string>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<AdminBrewInfo, string, unknown>(
      {
        mutationKey: mutationKeys.admin.unlock,
        mutationFn: (shareId) => unlockBrew(shareId),
        meta: { errorTitle: "Couldn't unlock the brew" },
        onSuccess: (brew) => afterLockChange(queryClient, brew),
      },
      overrides,
    ),
  );
}

/** Variables: the share id. */
export function useAdminDismissReview(overrides?: MutationOverrides<AdminBrewInfo, string>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<AdminBrewInfo, string, unknown>(
      {
        mutationKey: mutationKeys.admin.dismissReview,
        mutationFn: (shareId) => dismissLockReview(shareId),
        meta: { errorTitle: "Couldn't dismiss the review request" },
        onSuccess: (brew) => afterLockChange(queryClient, brew),
      },
      overrides,
    ),
  );
}

/**
 * After a notification change: the admin list is fetched again even while no page shows it (the
 * form navigates back to it once this resolves, so it never shows the old list), the other admin
 * notification queries become stale, and the site banner (active notices) is refreshed.
 */
async function afterNotificationChange(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.admin.notifications,
      predicate: (query) => query.queryKey[2] !== 'list',
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.notificationList(), refetchType: 'all' }),
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all }),
  ]);
}

export function useAdminCreateNotification(overrides?: MutationOverrides<NotificationInfo, NotificationInput>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<NotificationInfo, NotificationInput, unknown>(
      {
        mutationKey: mutationKeys.admin.createNotification,
        mutationFn: (input) => createNotification(input),
        meta: { errorTitle: "Couldn't create the notification" },
        onSuccess: (created) => {
          queryClient.setQueryData(queryKeys.admin.notification(created.id), created);
          return afterNotificationChange(queryClient);
        },
      },
      overrides,
    ),
  );
}

export interface UpdateNotificationVariables {
  id: string;
  input: NotificationInput;
}

export function useAdminUpdateNotification(overrides?: MutationOverrides<NotificationInfo, UpdateNotificationVariables>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<NotificationInfo, UpdateNotificationVariables, unknown>(
      {
        mutationKey: mutationKeys.admin.updateNotification,
        mutationFn: ({ id, input }) => updateNotification(id, input),
        meta: { errorTitle: "Couldn't update the notification" },
        onSuccess: (updated) => {
          queryClient.setQueryData(queryKeys.admin.notification(updated.id), updated);
          return afterNotificationChange(queryClient);
        },
      },
      overrides,
    ),
  );
}

/** Variables: the notification id. */
export function useAdminDeleteNotification(overrides?: MutationOverrides<void, string>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<void, string, unknown>(
      {
        mutationKey: mutationKeys.admin.deleteNotification,
        mutationFn: (id) => deleteNotification(id),
        meta: { errorTitle: "Couldn't delete the notification" },
        onSuccess: (_result, id) => {
          queryClient.removeQueries({ queryKey: queryKeys.admin.notification(id) });
          return afterNotificationChange(queryClient);
        },
      },
      overrides,
    ),
  );
}
