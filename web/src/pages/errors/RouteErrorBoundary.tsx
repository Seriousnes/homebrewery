// errorElement for the app's routes: a page that throws while rendering, or a lazy page module
// that fails to load (a deploy replaced the chunks, or the network dropped), gets an error page
// inside the shell instead of a blank screen.
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { isApiError } from '@/api';
import { isChunkLoadError } from './errorContent';
import { ErrorPage } from './ErrorPage';
import { NotFoundPage } from './NotFoundPage';

const reload = () => window.location.reload();

export function RouteErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) return <NotFoundPage />;
    return <ErrorPage status={error.status} message={typeof error.data === 'string' && error.data ? error.data : undefined} />;
  }
  if (isApiError(error)) return <ErrorPage error={error} onRetry={reload} />;
  if (isChunkLoadError(error)) {
    return (
      <ErrorPage
        status={0}
        title="This page could not be loaded"
        message="The site may have been updated, or the connection dropped. Reload the page to try again."
        onRetry={reload}
      />
    );
  }
  const details = import.meta.env.DEV && error instanceof Error ? (error.stack ?? error.message) : undefined;
  return (
    <ErrorPage
      status={500}
      title="Something went wrong"
      message="This page ran into an unexpected problem. Reloading usually helps."
      onRetry={reload}
      details={details}
    />
  );
}
