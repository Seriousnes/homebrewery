// /dev/shell: the app shell lane's harness. ErrorNavItem for every API outcome, the error pages,
// the sign-in prompt (raised directly, or by a real 401 from the API), and the recent-brews list.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { adminQueries, describeApiError, requestSignIn, useMe } from '@/api';
import { NavbarSlotsContext, NO_NAVBAR_SLOTS } from '@/app/navbarSlotsContext';
import { clearRecentBrews, recordRecentBrew } from '@/app/recentBrews';
import { ErrorPage } from '@/pages/errors/ErrorPage';
import { ErrorNavItem } from '@/ported/navbar/ErrorNavItem';
import navStyles from '@/ported/navbar/Navbar.module.css';
import { RecentNavItem } from '@/ported/navbar/RecentNavItem';
import { Button, Select, UiRoot } from '@/ui';
import { ERROR_SAMPLE_KEYS, ERROR_SAMPLES, type ErrorSample } from './samples';
import styles from './ShellDevPage.module.css';

export function ShellDevPage() {
  const [dismissed, setDismissed] = useState<ErrorSample[]>([]);
  const [lastAction, setLastAction] = useState('');
  const [page, setPage] = useState<ErrorSample>('404');
  const [loadProtected, setLoadProtected] = useState(false);
  const me = useMe();
  const stats = useQuery({ ...adminQueries.stats(), enabled: loadProtected, retry: false });

  return (
    <UiRoot className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>App shell</h1>
        <p className={styles.lead}>
          Signed in as: <output data-testid="me">{me.isPending ? '…' : (me.data?.handle ?? 'nobody')}</output>
        </p>
      </header>

      <section className={styles.section} aria-labelledby="error-items">
        <h2 id="error-items">Error nav item</h2>
        <NavbarSlotsContext value={NO_NAVBAR_SLOTS}>
          <nav className={navStyles.nav} aria-label="Error items" data-testid="error-items">
            {ERROR_SAMPLE_KEYS.filter((key) => !dismissed.includes(key)).map((key) => (
              <ErrorNavItem
                key={key}
                label={`Oops ${key}`}
                error={ERROR_SAMPLES[key]()}
                onRetry={() => setLastAction(`retry ${key}`)}
                onDismiss={() => {
                  setDismissed((list) => [...list, key]);
                  setLastAction(`dismiss ${key}`);
                }}
                data-testid={`nav-error-${key}`}
              />
            ))}
          </nav>
        </NavbarSlotsContext>
        <p>
          Last action: <output data-testid="last-action">{lastAction}</output>
        </p>
        <Button size="sm" onClick={() => setDismissed([])}>
          Show all again
        </Button>
      </section>

      <section className={styles.section} aria-labelledby="sign-in">
        <h2 id="sign-in">Sign-in prompt</h2>
        <div className={styles.row}>
          <Button onClick={() => requestSignIn()} data-testid="request-sign-in">
            Request sign-in
          </Button>
          <Button onClick={() => (loadProtected ? void stats.refetch() : setLoadProtected(true))} data-testid="load-protected">
            Load admin stats
          </Button>
        </div>
        <p>
          Admin stats:{' '}
          <output data-testid="protected-status">
            {!loadProtected ? 'not loaded' : stats.isFetching ? 'loading' : stats.isError ? `error ${stats.error.status}: ${describeApiError(stats.error)}` : stats.isSuccess ? `${stats.data.users} users` : 'idle'}
          </output>
        </p>
      </section>

      <section className={styles.section} aria-labelledby="recent">
        <h2 id="recent">Recent brews</h2>
        <div className={styles.row}>
          <Button onClick={() => recordRecentBrew('edit', { id: `edit${Date.now().toString(36)}`, title: 'Sample edited brew' })} data-testid="add-recent-edit">
            Add an edited brew
          </Button>
          <Button onClick={() => recordRecentBrew('view', { id: `view${Date.now().toString(36)}`, title: '' })} data-testid="add-recent-view">
            Add an untitled viewed brew
          </Button>
          <Button variant="danger" onClick={() => clearRecentBrews()} data-testid="clear-recent">
            Clear
          </Button>
        </div>
        <nav className={navStyles.nav} aria-label="Recent sample">
          <RecentNavItem />
        </nav>
      </section>

      <section className={styles.section} aria-labelledby="error-pages">
        <h2 id="error-pages">Error pages</h2>
        <Select
          label="Failure"
          value={page}
          options={ERROR_SAMPLE_KEYS.map((key) => ({ value: key, label: key }))}
          onChange={(event) => setPage(event.target.value as ErrorSample)}
          data-testid="error-page-select"
        />
        <div className={styles.preview} data-testid="error-page-preview">
          <ErrorPage key={page} error={ERROR_SAMPLES[page]()} onRetry={() => setLastAction(`page retry ${page}`)} />
        </div>
      </section>
    </UiRoot>
  );
}
