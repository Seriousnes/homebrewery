// The app's TanStack Query client (plan §9): server data lives here. Every failed query and
// mutation goes through the central error policy (web/src/api/errorPolicy.ts): 401 → sign-in
// prompt, 403/404/423 → the page's error state, 409 and field errors → the caller, the rest → a
// toast with Retry. meta { errorPolicy: 'manual' } opts a request out.
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import {
  type ApiError,
  applyErrorPolicy,
  type ErrorToast,
  errorToastId,
  queryKeys,
  requestSignIn,
  retryDelay,
  shouldRetryQuery,
} from '@/api';
import { dismissToast, toast } from '@/ui/toastStore';

export interface CreateQueryClientOptions {
  /** Where policy toasts go (default: the UI kit's toast()). */
  notify?: (toast: ErrorToast) => void;
  /** Called on 401 (default: requestSignIn, which the app's sign-in prompt listens to). */
  onSignIn?: (error: ApiError) => void;
  /** Removes a policy toast when its request later succeeds (default: the UI kit's dismissToast()). */
  dismiss?: (toastId: string) => void;
}

export function createQueryClient({ notify = toast, onSignIn = requestSignIn, dismiss = dismissToast }: CreateQueryClientOptions = {}): QueryClient {
  const signIn = (error: ApiError) => {
    // The session is gone (or never was): `me` is null until the user signs in again.
    client.setQueryData(queryKeys.account.me(), null);
    onSignIn(error);
  };

  const queryCache = new QueryCache({
    // A query that recovers (background refetch, Retry) takes its error toast with it.
    onSuccess: (_data, query) => dismiss(errorToastId(query.queryHash)),
    onError: (error, query) => {
      applyErrorPolicy(error, {
        source: 'query',
        meta: query.meta,
        key: query.queryHash,
        retry: () => void client.refetchQueries({ queryKey: query.queryKey, exact: true }),
        notify,
        onSignIn: signIn,
      });
    },
  });

  const mutationCache = new MutationCache({
    onSuccess: (_data, _variables, _onMutateResult, mutation) => dismiss(errorToastId(`mutation:${mutation.mutationId}`)),
    onError: (error, variables, _onMutateResult, mutation) => {
      applyErrorPolicy(error, {
        source: 'mutation',
        meta: mutation.meta,
        key: `mutation:${mutation.mutationId}`,
        retry: () => {
          mutation.execute(variables).catch(() => {
            // A second failure goes through this policy again.
          });
        },
        notify,
        onSignIn: signIn,
      });
    },
  });

  // The cache callbacks above run only after this is assigned.
  const client: QueryClient = new QueryClient({
    queryCache,
    mutationCache,
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: shouldRetryQuery,
        retryDelay,
      },
      mutations: {
        retry: false,
      },
    },
  });
  return client;
}
