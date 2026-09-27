import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { AppShell } from '@/app/AppShell';
import { RootErrorBoundary, RootHydrateFallback, RootLayout } from '@/app/RootLayout';
import { NotFoundPage } from '@/pages/errors/NotFoundPage';
import { RouteErrorBoundary } from '@/pages/errors/RouteErrorBoundary';

/**
 * Dev-only harness pages (web/src/dev/*\/route.tsx, see web/src/dev/registry.tsx), outside the
 * app shell. The condition is compile-time, so production builds drop the import entirely.
 */
export const DEV_ROUTES_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_HB_DEV_ROUTES === '1';

const devRoutes: RouteObject[] = DEV_ROUTES_ENABLED
  ? [{ path: '/dev/*', lazy: async () => ({ Component: (await import('@/dev/DevRoutes')).DevRoutes }) }]
  : [];

/** A lazily loaded page module: its default export is the page component. */
function page(load: () => Promise<{ default: ComponentType }>): RouteObject['lazy'] {
  return async () => ({ Component: (await load()).default });
}

/**
 * The app's pages (plan §9), children of the shell. Each page module is its own chunk
 * (web/src/pages/<name>/index.tsx, default export). Errors thrown while rendering or loading a
 * page show an error page inside the shell (RouteErrorBoundary on the pathless layout route).
 */
export const pageRoutes: RouteObject[] = [
  { index: true, lazy: page(() => import('@/pages/home')) },
  // /new, /edit/:editId and /local/:localId: one editor route (a pathless layout), so a new brew's
  // first save can move the URL to /edit/:editId (or /local/:localId, signed out) without
  // remounting the editor (web/src/pages/edit).
  {
    id: 'editor',
    lazy: page(() => import('@/pages/edit')),
    children: [
      { path: 'new', element: null },
      { path: 'edit/:editId', element: null },
      { path: 'local/:localId', element: null },
    ],
  },
  { path: 'local', lazy: page(() => import('@/pages/local')) },
  { path: 'share/:shareId', lazy: page(() => import('@/pages/share')) },
  { path: 'user/:handle', lazy: page(() => import('@/pages/user')) },
  { path: 'vault', lazy: page(() => import('@/pages/vault')) },
  { path: 'import', lazy: page(() => import('@/pages/import')) },
  // Admin sub-pages (locks, notifications, …) are the admin module's own nested routes.
  { path: 'admin/*', lazy: page(() => import('@/pages/admin')) },
  { path: 'account', lazy: page(() => import('@/pages/account/AccountPage')) },
  { path: 'login', lazy: page(() => import('@/pages/auth/LoginPage')) },
  { path: 'register', lazy: page(() => import('@/pages/auth/RegisterPage')) },
  { path: '*', element: <NotFoundPage /> },
];

export const routes: RouteObject[] = [
  {
    // The root adds the sign-in dialog for every route (dev pages included) and no markup.
    element: <RootLayout />,
    errorElement: <RootErrorBoundary />,
    hydrateFallbackElement: <RootHydrateFallback />,
    children: [
      {
        path: '/',
        element: <AppShell />,
        children: [{ errorElement: <RouteErrorBoundary />, children: pageRoutes }],
      },
      ...devRoutes,
    ],
  },
];
