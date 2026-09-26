// TanStack Query keys for every cached API resource. Invalidate by prefix, e.g.
// queryClient.invalidateQueries({ queryKey: queryKeys.users.all }).
import type { VaultSearchParams } from './types';

/** Vault params as they go into the key: trimmed, empty values dropped (so {} and {q: ''} match). */
export function normalizeVaultParams(params: VaultSearchParams = {}): VaultSearchParams {
  const out: VaultSearchParams = {};
  const q = params.q?.trim();
  if (q) out.q = q;
  const author = params.author?.trim();
  if (author) out.author = author.toLowerCase();
  if (params.page != null && params.page !== 1) out.page = params.page;
  if (params.pageSize != null) out.pageSize = params.pageSize;
  if (params.sort) out.sort = params.sort;
  if (params.dir) out.dir = params.dir;
  return out;
}

/** Handles are case-insensitive on the server (trim + lower-case); keys follow suit. */
export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

export const queryKeys = {
  account: {
    all: ['account'] as const,
    me: () => ['account', 'me'] as const,
  },
  brews: {
    all: ['brews'] as const,
    edit: (editId: string) => ['brews', 'edit', editId] as const,
    share: (shareId: string) => ['brews', 'share', shareId] as const,
  },
  themes: {
    all: ['themes'] as const,
    list: () => ['themes', 'list'] as const,
    bundle: (theme: string) => ['themes', 'bundle', theme] as const,
  },
  vault: {
    all: ['vault'] as const,
    search: (params: VaultSearchParams = {}) => ['vault', 'search', normalizeVaultParams(params)] as const,
  },
  users: {
    all: ['users'] as const,
    brews: (handle: string) => ['users', normalizeHandle(handle), 'brews'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    active: () => ['notifications', 'active'] as const,
  },
  admin: {
    all: ['admin'] as const,
    stats: () => ['admin', 'stats'] as const,
    users: (q: string) => ['admin', 'users', q.trim()] as const,
    brews: ['admin', 'brew'] as const,
    brew: (id: string) => ['admin', 'brew', id.trim()] as const,
    locks: () => ['admin', 'locks'] as const,
    reviewQueue: () => ['admin', 'locks', 'review-queue'] as const,
    notifications: ['admin', 'notifications'] as const,
    notificationList: () => ['admin', 'notifications', 'list'] as const,
    notification: (id: string) => ['admin', 'notifications', 'detail', id] as const,
  },
} as const;

/** Mutation keys (useIsMutating / useMutationState filters). */
export const mutationKeys = {
  register: ['account', 'register'] as const,
  login: ['account', 'login'] as const,
  logout: ['account', 'logout'] as const,
  setHandle: ['account', 'handle'] as const,
  changePassword: ['account', 'password'] as const,
  createBrew: ['brews', 'create'] as const,
  saveBrew: (editId: string) => ['brews', 'save', editId] as const,
  deleteBrew: ['brews', 'delete'] as const,
  cloneBrew: ['brews', 'clone'] as const,
  requestLockReview: ['brews', 'lock-review'] as const,
  importUpstream: ['import', 'homebrewery'] as const,
  admin: {
    lock: ['admin', 'lock'] as const,
    unlock: ['admin', 'unlock'] as const,
    dismissReview: ['admin', 'dismiss-review'] as const,
    createNotification: ['admin', 'notifications', 'create'] as const,
    updateNotification: ['admin', 'notifications', 'update'] as const,
    deleteNotification: ['admin', 'notifications', 'delete'] as const,
  },
} as const;
