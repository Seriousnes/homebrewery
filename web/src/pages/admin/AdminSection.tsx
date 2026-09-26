// Layout of every admin page: the site page (h1, tab title "<title> - Admin") and the admin
// section navigation (upstream's admin tabs, as links so each tool has its own address).
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { useAdminStats } from '@/api/admin';
import { SitePage } from '@/app/SitePage';
import styles from './Admin.module.css';
import { ADMIN_SECTIONS } from './adminPaths';

export interface AdminSectionProps {
  /** The h1 and the start of the tab title. */
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
  'data-testid'?: string;
}

export function AdminSection({ title, lead, children, 'data-testid': testId }: AdminSectionProps) {
  return (
    <SitePage title={title === 'Admin' ? title : `${title} - Admin`} heading={title} lead={lead} width="wide" data-testid={testId}>
      <AdminNav />
      {children}
    </SitePage>
  );
}

/** The admin sections; Locks carries the number of pending review requests. */
export function AdminNav() {
  // The overview's query (same key, so one toast id on failure). Fetched again whenever an admin
  // page opens: review requests come from authors, so the badge must not wait for staleness.
  const stats = useAdminStats({ refetchOnMount: 'always' });
  const reviews = stats.data?.pendingReviews ?? 0;
  return (
    <nav className={styles.nav} aria-label="Admin sections" data-testid="admin-nav">
      <ul className={styles.navList}>
        {ADMIN_SECTIONS.map((section) => {
          const badge = section.id === 'locks' && reviews > 0 ? reviews : null;
          return (
            <li key={section.id}>
              <NavLink
                to={section.to}
                end={section.end}
                className={styles.navLink}
                // The name says what the badge counts ("Locks, 2 awaiting review"; it starts with the
                // visible text). The badge shows only the number.
                aria-label={badge ? `${section.label}, ${badge} awaiting review` : undefined}
                data-testid={`admin-nav-${section.id}`}
              >
                {section.label}
                {badge ? (
                  <span className={styles.badge} aria-hidden="true" data-testid="admin-nav-reviews">
                    {badge}
                  </span>
                ) : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
