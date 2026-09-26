// Vitest helpers for the app shell lane's component tests (never import from app code).
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { configure, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { createMemoryRouter, type RouteObject, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { AccountInfo, ErrorToast } from '@/api';
import { queryKeys } from '@/api';
import { createQueryClient } from './queryClient';
import { RootLayout } from './RootLayout';
import { TestLocationProbe } from './TestLocationProbe';

// findBy/waitFor wait up to 3 s for lazy routes and queries: below the 5 s test timeout, so a
// missing element fails with Testing Library's message (CLAUDE.md "Tests fail fast").
configure({ asyncUtilTimeout: 3000 });

export const ALICE: AccountInfo = { id: '0190-alice', handle: 'alice', email: 'alice@example.test', roles: [] };
export const ADMIN: AccountInfo = { id: '0190-admin', handle: 'boss', email: 'boss@example.test', roles: ['Admin'] };

/** The app's query client (central error policy) without retries or delays; toasts go to `notify`. */
export function testQueryClient(notify: (toast: ErrorToast) => void = vi.fn()): QueryClient {
  const client = createQueryClient({ notify, dismiss: vi.fn() });
  client.setDefaultOptions({
    queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
    mutations: { retry: false },
  });
  return client;
}

export interface RenderRouteOptions {
  /** Initial URL (default '/'). */
  url?: string;
  /** The route path `element` is mounted at (default '*'). */
  path?: string;
  /** More routes next to it (e.g. navigation targets). */
  routes?: RouteObject[];
  /** Pre-set `me` (undefined: not in the cache, so it is fetched). */
  me?: AccountInfo | null;
  client?: QueryClient;
}

/** Render `element` inside the app's providers: query client, memory router and RootLayout. */
export function renderRoute(element: ReactElement, { url = '/', path = '*', routes = [], me, client }: RenderRouteOptions = {}) {
  const queryClient = client ?? testQueryClient();
  if (me !== undefined) queryClient.setQueryData(queryKeys.account.me(), me);
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <RootLayout />
            <TestLocationProbe />
          </>
        ),
        children: [{ path, element }, ...routes],
      },
    ],
    { initialEntries: [url] },
  );
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient, user };
}
