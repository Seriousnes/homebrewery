// Option types for the API hooks and the helper that merges a caller's mutation options with the
// hook's own cache updates (both run: the hook's first).
import type { QueryKey, UseMutationOptions, UseQueryOptions } from '@tanstack/react-query';
import type { ApiError } from './errors';

/** Extra useQuery options a caller may pass to an API query hook (not key, fn or select). */
export type QueryOverrides<TData, TKey extends QueryKey = QueryKey> = Omit<
  UseQueryOptions<TData, ApiError, TData, TKey>,
  'queryKey' | 'queryFn' | 'select'
>;

/** Extra useMutation options a caller may pass to an API mutation hook. Callbacks run after the hook's. */
export type MutationOverrides<TData, TVariables, TOnMutateResult = unknown> = Omit<
  UseMutationOptions<TData, ApiError, TVariables, TOnMutateResult>,
  'mutationFn' | 'mutationKey'
>;

type MutationOpts<TData, TVariables, TOnMutateResult> = UseMutationOptions<TData, ApiError, TVariables, TOnMutateResult>;

/** base + overrides; meta is merged, onSuccess/onError/onSettled run base first, then the override. */
export function mergeMutationOptions<TData, TVariables, TOnMutateResult>(
  base: MutationOpts<TData, TVariables, TOnMutateResult>,
  overrides?: MutationOverrides<TData, TVariables, TOnMutateResult>,
): MutationOpts<TData, TVariables, TOnMutateResult> {
  if (!overrides) return base;
  const merged: MutationOpts<TData, TVariables, TOnMutateResult> = { ...base, ...overrides };
  if (base.meta || overrides.meta) merged.meta = { ...base.meta, ...overrides.meta };
  const { onSuccess: a, onError: b, onSettled: c } = base;
  const { onSuccess: x, onError: y, onSettled: z } = overrides;
  if (a && x) {
    merged.onSuccess = async (...args) => {
      await a(...args);
      await x(...args);
    };
  }
  if (b && y) {
    merged.onError = async (...args) => {
      await b(...args);
      await y(...args);
    };
  }
  if (c && z) {
    merged.onSettled = async (...args) => {
      await c(...args);
      await z(...args);
    };
  }
  return merged;
}
