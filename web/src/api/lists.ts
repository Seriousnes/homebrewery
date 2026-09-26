// Brew lists: the vault search and a user's brews (plan §8.3).
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import { api, type CallOptions, unwrap } from './client';
import type { ApiError } from './errors';
import type { QueryOverrides } from './hookOptions';
import { normalizeHandle, normalizeVaultParams, queryKeys } from './keys';
import type { UserBrewList, VaultPage, VaultSearchParams } from './types';

/** Published, unlocked brews. 400 errors.sort / errors.dir / errors.q. */
export async function searchVault(params: VaultSearchParams = {}, { client = api, signal }: CallOptions = {}): Promise<VaultPage> {
  return unwrap(client.GET('/api/vault', { params: { query: normalizeVaultParams(params) }, signal }), {
    method: 'GET',
    url: '/api/vault',
  });
}

/** A user's brews; `own` lists (the caller's) include unpublished, locked and invited ones. 404 unknown user. */
export async function fetchUserBrews(handle: string, { client = api, signal }: CallOptions = {}): Promise<UserBrewList> {
  const normalized = normalizeHandle(handle);
  return unwrap(client.GET('/api/users/{handle}/brews', { params: { path: { handle: normalized } }, signal }), {
    method: 'GET',
    url: `/api/users/${normalized}/brews`,
  });
}

export const listQueries = {
  /** Keeps the previous page on screen while the next one loads. */
  vault: (params: VaultSearchParams = {}) =>
    queryOptions<VaultPage, ApiError>({
      queryKey: queryKeys.vault.search(params),
      queryFn: ({ signal }) => searchVault(params, { signal }),
      placeholderData: keepPreviousData,
    }),
  userBrews: (handle: string) =>
    queryOptions<UserBrewList, ApiError>({
      queryKey: queryKeys.users.brews(handle),
      queryFn: ({ signal }) => fetchUserBrews(handle, { signal }),
    }),
};

export function useVaultSearch(params: VaultSearchParams = {}, overrides?: QueryOverrides<VaultPage>) {
  return useQuery({ ...listQueries.vault(params), ...overrides });
}

export function useUserBrews(handle: string | undefined, overrides?: QueryOverrides<UserBrewList>) {
  return useQuery({ ...listQueries.userBrews(handle ?? ''), enabled: Boolean(handle?.trim()), ...overrides });
}
