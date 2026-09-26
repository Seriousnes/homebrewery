// Account and Identity (plan §8.6). /api/auth/* are ASP.NET Identity's MapIdentityApi endpoints:
// they have no operationIds, so they are called by path.
import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, type CallOptions, unwrap } from './client';
import { type ApiError, isApiError } from './errors';
import { mergeMutationOptions, type MutationOverrides, type QueryOverrides } from './hookOptions';
import { mutationKeys, queryKeys } from './keys';
import type { AccountInfo, RegisterRequest } from './types';

// ─── Calls ──────────────────────────────────────────────────────────────────────────────────────

/** The signed-in account, or null when anonymous (204). */
export async function fetchMe({ client = api, signal }: CallOptions = {}): Promise<AccountInfo | null> {
  const data = await unwrap(client.GET('/api/account/me', { signal }), { method: 'GET', url: '/api/account/me' });
  return data ?? null;
}

/**
 * Create an account. Note: an email that is already registered also gets 200 (no account
 * enumeration); a following sign-in then fails with 401.
 */
export async function register(body: RegisterRequest, { client = api, signal }: CallOptions = {}): Promise<void> {
  await unwrap(client.POST('/api/auth/register', { body, signal }), { method: 'POST', url: '/api/auth/register' });
}

export interface LoginVariables {
  email: string;
  password: string;
  /** true (default): persistent cookie (?useCookies=true); false: session cookie (?useSessionCookies=true). */
  remember?: boolean;
  twoFactorCode?: string;
}

/** Cookie sign-in. A failure is 401 with detail 'Failed' | 'LockedOut' | 'NotAllowed' | 'RequiresTwoFactor'. */
export async function login(
  { email, password, remember = true, twoFactorCode }: LoginVariables,
  { client = api, signal }: CallOptions = {},
): Promise<void> {
  await unwrap(
    client.POST('/api/auth/login', {
      params: { query: remember ? { useCookies: true } : { useSessionCookies: true } },
      body: { email, password, ...(twoFactorCode ? { twoFactorCode } : {}) },
      signal,
    }),
    { method: 'POST', url: '/api/auth/login' },
  );
}

export type LoginFailure = 'invalid' | 'lockedOut' | 'notAllowed' | 'requiresTwoFactor';

/** Why a login failed (from Identity's 401 detail), or null for other errors. */
export function loginFailure(error: unknown): LoginFailure | null {
  if (!isApiError(error) || error.status !== 401) return null;
  switch (error.detail?.toLowerCase()) {
    case 'lockedout':
      return 'lockedOut';
    case 'notallowed':
      return 'notAllowed';
    case 'requirestwofactor':
      return 'requiresTwoFactor';
    default:
      return 'invalid';
  }
}

export async function logout({ client = api, signal }: CallOptions = {}): Promise<void> {
  await unwrap(client.POST('/api/account/logout', { signal }), { method: 'POST', url: '/api/account/logout' });
}

export interface ChangePasswordVariables {
  oldPassword: string;
  newPassword: string;
}

/**
 * Change the password (Identity's POST /api/auth/manage/info). 400 is a ValidationProblem keyed
 * by Identity error codes: PasswordMismatch (wrong current password), OldPasswordRequired, and the
 * password rules (PasswordTooShort, PasswordRequiresDigit, …).
 */
export async function changePassword({ oldPassword, newPassword }: ChangePasswordVariables, { client = api, signal }: CallOptions = {}): Promise<void> {
  await unwrap(client.POST('/api/auth/manage/info', { body: { oldPassword, newPassword }, signal }), {
    method: 'POST',
    url: '/api/auth/manage/info',
  });
}

/** Set the public handle. 400 errors.handle (format), 409 'Handle taken'. */
export async function setHandle(handle: string, { client = api, signal }: CallOptions = {}): Promise<AccountInfo> {
  return unwrap(client.PUT('/api/account/handle', { body: { handle }, signal }), { method: 'PUT', url: '/api/account/handle' });
}

// ─── Queries ────────────────────────────────────────────────────────────────────────────────────

export const accountQueries = {
  me: () =>
    queryOptions<AccountInfo | null, ApiError>({
      queryKey: queryKeys.account.me(),
      queryFn: ({ signal }) => fetchMe({ signal }),
      staleTime: 5 * 60_000,
    }),
};

/** The signed-in account (data null when anonymous). */
export function useMe(overrides?: QueryOverrides<AccountInfo | null>) {
  return useQuery({ ...accountQueries.me(), ...overrides });
}

/**
 * After the signed-in user changes: refetch what depends on who is asking (lists, themes, failed
 * page loads). A loaded editor brew is left alone — the editor owns that document — and so is a
 * loaded share view: every fetch counts a view, and the share page itself asks again when a
 * reader who signs in turns out to be an author. On sign-out inactive private caches (brews for
 * edit, admin) are dropped.
 */
function refreshUserData(queryClient: QueryClient, dropPrivate: boolean): Promise<void> {
  if (dropPrivate) {
    queryClient.removeQueries({ queryKey: queryKeys.admin.all, type: 'inactive' });
    queryClient.removeQueries({ queryKey: queryKeys.brews.all, type: 'inactive' });
  }
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const [scope, kind] = query.queryKey;
      if (scope === queryKeys.account.all[0]) return false;
      if (scope !== queryKeys.brews.all[0] || query.state.status !== 'success') return true;
      return kind !== 'edit' && kind !== 'share';
    },
  });
}

// ─── Mutations ──────────────────────────────────────────────────────────────────────────────────

export function useRegister(overrides?: MutationOverrides<void, RegisterRequest>) {
  return useMutation(
    mergeMutationOptions<void, RegisterRequest, unknown>(
      {
        mutationKey: mutationKeys.register,
        mutationFn: (body) => register(body),
        meta: { errorTitle: "Couldn't create the account" },
      },
      overrides,
    ),
  );
}

/** Sign in, then refetch `me` and every user-dependent query. Its 401 is the form's to show (manual policy). */
export function useLogin(overrides?: MutationOverrides<void, LoginVariables>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<void, LoginVariables, unknown>(
      {
        mutationKey: mutationKeys.login,
        mutationFn: (vars) => login(vars),
        meta: { errorPolicy: 'manual' },
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.account.me() });
          await refreshUserData(queryClient, false);
        },
      },
      overrides,
    ),
  );
}

/** Sign out: `me` becomes null, unused private caches (brews for edit, admin) are dropped, the rest refetch. */
export function useLogout(overrides?: MutationOverrides<void, void>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<void, void, unknown>(
      {
        mutationKey: mutationKeys.logout,
        mutationFn: () => logout(),
        meta: { errorTitle: "Couldn't sign out" },
        onSuccess: async () => {
          queryClient.setQueryData(queryKeys.account.me(), null);
          await refreshUserData(queryClient, true);
        },
      },
      overrides,
    ),
  );
}

/**
 * Change the password, then sign in again with the new one (`email`: the account's). Identity
 * renews the account's security stamp on a password change, and the session cookie would stop
 * working at its next stamp check (up to 30 minutes later); the new sign-in keeps this session.
 * If that sign-in fails, the password was still changed. 400 (field errors) is the caller's.
 */
export function useChangePassword(email: string | null, overrides?: MutationOverrides<void, ChangePasswordVariables>) {
  return useMutation(
    mergeMutationOptions<void, ChangePasswordVariables, unknown>(
      {
        mutationKey: mutationKeys.changePassword,
        mutationFn: async (vars) => {
          await changePassword(vars);
          if (!email) return;
          try {
            await login({ email, password: vars.newPassword, remember: true });
          } catch {
            // The change stands; this session ends at the next stamp check and asks to sign in.
          }
        },
        meta: { errorTitle: "Couldn't change the password" },
      },
      overrides,
    ),
  );
}

/** Set the handle; `me` is updated from the response and user lists are invalidated. */
export function useSetHandle(overrides?: MutationOverrides<AccountInfo, string>) {
  const queryClient = useQueryClient();
  return useMutation(
    mergeMutationOptions<AccountInfo, string, unknown>(
      {
        mutationKey: mutationKeys.setHandle,
        mutationFn: (handle) => setHandle(handle),
        meta: { errorTitle: "Couldn't change the handle" },
        onSuccess: async (account) => {
          queryClient.setQueryData(queryKeys.account.me(), account);
          await queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
        },
      },
      overrides,
    ),
  );
}
