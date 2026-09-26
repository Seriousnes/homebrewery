// /admin: site totals (upstream's admin "Stats": brew and published counts, plus users, locks and
// pending reviews) and quick lookups that lead to the user and brew tools.
import { type FormEvent, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AdminStats } from '@/api';
import { useAdminStats } from '@/api/admin';
import { Button, TextField } from '@/ui';
import styles from './Admin.module.css';
import { formatCount } from './adminModel';
import { Loading, QueryError, Time } from './adminParts';
import { adminPaths } from './adminPaths';
import { AdminSection } from './AdminSection';

interface StatTile {
  key: keyof AdminStats;
  label: string;
  link?: { to: string; text: string };
}

const TILES: readonly StatTile[] = [
  { key: 'brews', label: 'Brews' },
  { key: 'publishedBrews', label: 'Published brews' },
  { key: 'users', label: 'Accounts' },
  { key: 'lockedBrews', label: 'Locked brews', link: { to: adminPaths.locks, text: 'See the locks' } },
  { key: 'pendingReviews', label: 'Awaiting review', link: { to: adminPaths.reviewQueue, text: 'Open the review queue' } },
];

export default function OverviewPage() {
  const stats = useAdminStats();
  const statsId = useId();
  const lookupId = useId();

  return (
    <AdminSection title="Admin" lead="Site totals, lookups, brew locks and site notifications." data-testid="admin-overview">
      <section className={styles.card} aria-labelledby={statsId}>
        <div className={styles.cardHeader}>
          <h2 id={statsId} className={styles.cardTitle}>
            Totals
          </h2>
          <div className={styles.actions}>
            {stats.data ? (
              <span className={`${styles.muted} ${styles.small}`}>
                Updated <Time value={new Date(stats.dataUpdatedAt).toISOString()} relative />
              </span>
            ) : null}
            <Button size="sm" loading={stats.isFetching} onClick={() => void stats.refetch()} data-testid="admin-stats-refresh">
              Refresh
            </Button>
          </div>
        </div>
        {stats.data ? (
          <ul className={styles.stats} data-testid="admin-stats">
            {TILES.map((tile) => (
              <li key={tile.key} className={styles.stat} data-testid={`admin-stat-${tile.key}`}>
                <p className={styles.statLabel}>{tile.label}</p>
                <p className={styles.statValue} data-testid={`admin-stat-${tile.key}-value`}>
                  {formatCount(stats.data[tile.key])}
                </p>
                {tile.link ? (
                  <Link className={`${styles.link} ${styles.statLink}`} to={tile.link.to}>
                    {tile.link.text}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : stats.error ? (
          <QueryError error={stats.error} what="the totals" onRetry={() => void stats.refetch()} />
        ) : (
          <Loading>Loading the totals…</Loading>
        )}
      </section>

      <section className={styles.card} aria-labelledby={lookupId}>
        <h2 id={lookupId} className={styles.cardTitle}>
          Look up
        </h2>
        <div className={styles.formRow}>
          <QuickLookup
            label="Find an account"
            hint="Part of a handle or email, or a user id."
            button="Find"
            name="user"
            toPath={(value) => adminPaths.users(value)}
          />
          <QuickLookup
            label="Find a brew"
            hint="Its share id, edit id or internal id."
            button="Look up"
            name="brew"
            toPath={(value) => adminPaths.brew(value)}
          />
        </div>
      </section>
    </AdminSection>
  );
}

interface QuickLookupProps {
  label: string;
  hint: string;
  button: string;
  name: string;
  toPath: (value: string) => string;
}

function QuickLookup({ label, hint, button, name, toPath }: QuickLookupProps) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Enter something to look for.');
      return;
    }
    void navigate(toPath(trimmed));
  };
  return (
    <form className={styles.search} onSubmit={submit} noValidate role="search" aria-label={label}>
      <TextField
        className={styles.searchField}
        label={label}
        hint={hint}
        name={name}
        autoComplete="off"
        spellCheck={false}
        value={value}
        error={error}
        onChange={(event) => {
          setValue(event.target.value);
          setError(undefined);
        }}
        data-testid={`admin-quick-${name}`}
      />
      <Button type="submit" className={styles.searchButton} data-testid={`admin-quick-${name}-submit`}>
        {button}
      </Button>
    </form>
  );
}
