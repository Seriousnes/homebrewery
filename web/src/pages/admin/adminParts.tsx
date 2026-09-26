// Small building blocks shared by the admin pages: an inline load error with Retry, a loading line,
// status pills, times, and a focusable scroll region for wide tables.
import clsx from 'clsx';
import { type ReactNode, useId } from 'react';
import { describeApiError, isApiError } from '@/api';
import { formatDateTime, formatRelativeTime } from '@/app/relativeTime';
import { Button, Icon, Spinner } from '@/ui';
import styles from './Admin.module.css';

export interface QueryErrorProps {
  error: unknown;
  /** What failed to load, e.g. "the locks" → "Couldn't load the locks". */
  what: string;
  onRetry?: () => void;
  'data-testid'?: string;
}

/** A failed load, in place of the content (role="alert"), with Retry. */
export function QueryError({ error, what, onRetry, 'data-testid': testId }: QueryErrorProps) {
  let message = describeApiError(error);
  if (isApiError(error) && error.status === 403) message = 'Your account no longer has the Admin role.';
  if (isApiError(error) && error.status === 401) message = 'Your session has ended. Sign in again.';
  return (
    <div role="alert" className={styles.error} data-testid={testId ?? 'admin-error'}>
      <Icon name="error" size={18} />
      <div>
        <p className={styles.errorTitle}>Couldn&apos;t load {what}</p>
        <p className={styles.errorText}>{message}</p>
        {onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** "Loading …" with a spinner (role="status"). */
export function Loading({ children }: { children: ReactNode }) {
  return (
    <p className={styles.loading} role="status">
      <Spinner size={16} decorative />
      {children}
    </p>
  );
}

export type PillTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const PILL_TONES: Record<PillTone, string | undefined> = {
  neutral: styles.pillNeutral,
  success: styles.pillSuccess,
  warning: styles.pillWarning,
  danger: styles.pillDanger,
  info: styles.pillInfo,
};

/** A short state label; the text always says the state (colour is never the only cue). */
export function Pill({ tone = 'neutral', children, 'data-testid': testId }: { tone?: PillTone; children: ReactNode; 'data-testid'?: string }) {
  return (
    <span className={clsx(styles.pill, PILL_TONES[tone])} data-testid={testId}>
      {children}
    </span>
  );
}

/** A time as "Sep 25, 2026, 2:05 PM", with the relative time ("3 days ago") when `relative`. */
export function Time({ value, relative = false, fallback = '—' }: { value: string | null | undefined; relative?: boolean; fallback?: string }) {
  if (!value) return <>{fallback}</>;
  const full = formatDateTime(value);
  if (!full) return <>{fallback}</>;
  return (
    <time dateTime={value} title={relative ? full : undefined}>
      {relative ? formatRelativeTime(value) : full}
    </time>
  );
}

export interface TableRegionProps {
  /** The table's caption (also names the scroll region). */
  caption: ReactNode;
  /** Hide the caption visually (a heading above already says it). */
  hideCaption?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}

/**
 * A wide table in a horizontally scrollable, keyboard-focusable wrapper named by the caption
 * (axe scrollable-region-focusable). The wrapper is a group, not a region: the card around it is
 * already a region, often with the same name, and two landmarks may not share one
 * (axe landmark-unique). `children` are the thead/tbody.
 */
export function TableRegion({ caption, hideCaption = false, children, 'data-testid': testId }: TableRegionProps) {
  const captionId = useId();
  return (
    <div className={styles.tableWrap} role="group" aria-labelledby={captionId} tabIndex={0} data-testid={testId}>
      <table className={styles.table}>
        <caption id={captionId} className={hideCaption ? styles.srOnly : undefined}>
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}
