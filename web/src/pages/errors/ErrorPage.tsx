// Error pages (port of legacy client/homebrew/pages/errorPage): 401 is the sign-in prompt, 403
// and 404 explain and link on, 423 shows the lock message, anything else offers a retry.
// Render <ErrorPage error={query.error} /> for a failed page load; the policy doesn't toast those.
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { paths } from '@/app/paths';
import { SitePage } from '@/app/SitePage';
import { Button, Icon } from '@/ui';
import { SignInRequired } from '../auth/SignInRequired';
import { errorContent } from './errorContent';
import styles from './ErrorPages.module.css';

export interface ErrorPageProps {
  /** The failure (usually an ApiError from a query). */
  error?: unknown;
  /** Without an error: the status to explain (default 500). */
  status?: number;
  /** Replaces the default heading. */
  title?: string;
  /** Replaces the default message. */
  message?: ReactNode;
  /** Shows "Try again" (for transient failures, or always when there is no error). */
  onRetry?: () => void;
  /** Extra details (developer builds show crash stacks here). */
  details?: string;
  children?: ReactNode;
}

export function ErrorPage({ error, status, title, message, onRetry, details, children }: ErrorPageProps) {
  const content = errorContent({ error, status });

  if (content.status === 401) return <SignInRequired title={title} message={message} />;

  const heading = title ?? content.title;
  const showRetry = onRetry && (content.transient || error === undefined);
  return (
    <SitePage title={heading} className={styles.page} data-testid="error-page">
      <p className={styles.status}>{content.status > 0 ? `Error ${content.status}` : 'No connection'}</p>
      {content.status === 423 ? (
        <section className={styles.lock} aria-labelledby="lock-reason-heading">
          <h2 id="lock-reason-heading" className={styles.lockHeading}>
            <Icon name="lock" size={18} />
            Why it is locked
          </h2>
          <p className={styles.lockReason}>{content.lockReason || 'No reason was given.'}</p>
          {content.code != null ? <p className={styles.lockCode}>Lock code {content.code}</p> : null}
        </section>
      ) : null}
      <p className={styles.message}>
        {message ??
          (content.status === 423
            ? 'It stays hidden until the lock is removed. If you are one of its authors, open it in the editor to see what to change and to ask for a review.'
            : content.message)}
      </p>
      {details ? (
        <details className={styles.details}>
          <summary>Details</summary>
          <pre>{details}</pre>
        </details>
      ) : null}
      {showRetry || children ? (
        <div className={styles.actions}>
          {showRetry ? (
            <Button variant="primary" icon="redo" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          {children}
        </div>
      ) : null}
      <ul className={styles.links} aria-label="Where to go next">
        <li>
          <Link className={styles.link} to={paths.home}>
            Go to the home page
          </Link>
        </li>
        <li>
          <Link className={styles.link} to={paths.vault}>
            Search the vault
          </Link>
        </li>
      </ul>
    </SitePage>
  );
}
