import { Outlet } from 'react-router';
import { RouteErrorBoundary } from '@/pages/errors/RouteErrorBoundary';
import { UiRoot } from '@/ui';
import { PageLoading } from './PageLoading';
import { SignInPrompt } from './SignInPrompt';

/**
 * The router's root: every route (the app shell and the dev pages) plus the sign-in dialog, so a
 * 401 anywhere can prompt. It adds no markup of its own around the pages.
 */
export function RootLayout() {
  return (
    <>
      <Outlet />
      <SignInPrompt />
    </>
  );
}

/** errorElement of the root route: the shell itself failed, so the error page stands alone. */
export function RootErrorBoundary() {
  return (
    <UiRoot>
      <RouteErrorBoundary />
    </UiRoot>
  );
}

/** Shown while the first route's lazy page module loads. */
export function RootHydrateFallback() {
  return (
    <UiRoot>
      <PageLoading fullScreen />
    </UiRoot>
  );
}
