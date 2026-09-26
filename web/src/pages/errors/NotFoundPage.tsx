import { ErrorPage } from './ErrorPage';

/** Unknown routes (the shell's catch-all). */
export function NotFoundPage() {
  return <ErrorPage status={404} title="Page not found" message="There is nothing at this address. Check the link, or start from the home page." />;
}
