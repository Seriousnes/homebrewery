// Port of legacy client/homebrew/navbar/error-navitem.jsx: an "Oops!" item in the navbar when a
// save (or another background request) failed. Upstream showed the message on hover; here the
// item is a disclosure whose panel explains the problem and offers what can be done about it.
// Pages render it into the navbar with <NavbarPortal slot="items">.
import { requestSignIn } from '@/api';
import { siteLinks } from '@/app/siteLinks';
import { Button, Icon, VisuallyHidden } from '@/ui';
import { NavDisclosure } from './NavDisclosure';
import styles from './Navbar.module.css';
import { describeSaveError, errorReport } from './saveErrorMessages';

export interface ErrorNavItemProps {
  /** The failure (an ApiError from the API layer, or anything thrown). */
  error: unknown;
  /** "Try again" (shown for transient failures when given). */
  onRetry?: () => void;
  /** "Dismiss": the page clears its error. */
  onDismiss?: () => void;
  /** Trigger text; default "Oops!". */
  label?: string;
  'data-testid'?: string;
}

export function ErrorNavItem({ error, onRetry, onDismiss, label = 'Oops!', 'data-testid': testId = 'nav-error' }: ErrorNavItemProps) {
  const { message, actions } = describeSaveError(error);
  return (
    <NavDisclosure
      label={label}
      aria-label={`${label} There was a problem saving. Show details`}
      icon={<Icon name="warning" />}
      triggerClassName={styles.error}
      panelLabel="Problem saving"
      panelClassName={styles.errorPanel}
      data-testid={testId}
    >
      {(close) => (
        <>
          <h2 className={styles.errorTitle}>Oops!</h2>
          <p className={styles.errorMessage}>{message}</p>
          <div className={styles.errorActions}>
            {actions.includes('signIn') ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  close();
                  requestSignIn();
                }}
              >
                Sign in
              </Button>
            ) : null}
            {actions.includes('retry') && onRetry ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  close();
                  onRetry();
                }}
              >
                Try again
              </Button>
            ) : null}
            {actions.includes('reload') ? (
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload the page
              </Button>
            ) : null}
            {actions.includes('report') ? (
              <a className={styles.textLink} href={siteLinks.bugReport(errorReport(error))} target="_blank" rel="noopener noreferrer">
                Report the issue
                <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
              </a>
            ) : null}
            {onDismiss ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  close();
                  onDismiss();
                }}
              >
                {actions.includes('signIn') ? 'Not now' : 'Dismiss'}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </NavDisclosure>
  );
}
