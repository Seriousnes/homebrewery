import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './SitePage.module.css';
import { usePageTitle } from './usePageTitle';

export interface SitePageProps {
  /** The h1 text and the document title. */
  title: string;
  /** Shown instead of `title` in the h1 (e.g. with an icon); `title` still names the tab. */
  heading?: ReactNode;
  /** Short text under the heading. */
  lead?: ReactNode;
  /** Content box width: 'narrow' forms (32rem), 'normal' (52rem, default), 'wide' lists (76rem). */
  width?: 'narrow' | 'normal' | 'wide';
  children?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

/**
 * Layout for the app's own (non-editor) pages: account, sign-in, errors, lists. It paints the UI
 * kit surface (font, colours, background) inside <main>, so editor pages, which don't use it,
 * keep the canvas free of chrome styles (plan §5).
 */
export function SitePage({ title, heading, lead, width = 'normal', children, className, 'data-testid': testId }: SitePageProps) {
  usePageTitle(title);
  return (
    <div className={clsx(styles.page, className)} data-testid={testId}>
      <div className={clsx(styles.content, styles[width])}>
        <h1 className={styles.heading} tabIndex={-1} data-route-focus="">
          {heading ?? title}
        </h1>
        {lead ? <p className={styles.lead}>{lead}</p> : null}
        {children}
      </div>
    </div>
  );
}
