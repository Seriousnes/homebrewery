// /admin/users?q=: account search (handle or email substring, or a user id; at most 50 results).
// Upstream's admin page only had an "author lookup" listing a handle's brews; here a result opens
// the account's page (/admin/users/:handle) with its details and every brew.
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { isApiError } from '@/api';
import { useAdminUsers } from '@/api/admin';
import { Button, TextField } from '@/ui';
import styles from './Admin.module.css';
import { formatCount, isLockedOut, MAX_USER_RESULTS } from './adminModel';
import { Loading, Pill, QueryError, TableRegion, Time } from './adminParts';
import { adminPaths } from './adminPaths';
import { AdminSection } from './AdminSection';

export default function UsersPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const users = useAdminUsers(q);
  const [value, setValue] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  const [inputError, setInputError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  const [now] = useState(() => Date.now());

  // Back/forward (or a quick lookup from the overview) changes ?q=: the field follows it.
  if (q !== lastQ) {
    setLastQ(q);
    setValue(q);
    setInputError(undefined);
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = value.trim();
    if (!next) {
      setInputError('Enter part of a handle or email, or a user id.');
      inputRef.current?.focus();
      return;
    }
    setInputError(undefined);
    if (next === q) void users.refetch();
    else setParams({ q: next });
  };

  const fieldError = isApiError(users.error) && users.error.status === 400 ? (users.error.fieldError('q') ?? users.error.title) : undefined;

  return (
    <AdminSection title="Users" lead="Find an account by handle, email or id, then open it to see its brews." data-testid="admin-users">
      <form className={styles.search} onSubmit={submit} noValidate role="search" aria-label="Find accounts">
        <TextField
          ref={inputRef}
          className={styles.searchField}
          label="Handle, email or user id"
          name="q"
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={value}
          error={inputError ?? (fieldError ? `The search ${fieldError}.` : undefined)}
          onChange={(event) => {
            setValue(event.target.value);
            setInputError(undefined);
          }}
          data-testid="admin-user-search"
        />
        <Button type="submit" variant="primary" icon="search" className={styles.searchButton} loading={users.isFetching} data-testid="admin-user-search-submit">
          Search
        </Button>
      </form>

      {q ? (
        <section aria-labelledby={resultsId}>
          <h2 id={resultsId} className={styles.subTitle}>
            Results
          </h2>
          <p role="status" className={styles.text} data-testid="admin-user-count">
            {users.data
              ? users.data.length === 0
                ? `No accounts match “${q}”.`
                : `${formatCount(users.data.length)} ${users.data.length === 1 ? 'account matches' : 'accounts match'} “${q}”.${users.data.length >= MAX_USER_RESULTS ? ` Only the first ${MAX_USER_RESULTS} are shown: search for more of the handle or email.` : ''}`
              : ''}
          </p>
          {users.data && users.data.length > 0 ? (
            <TableRegion caption={`Accounts matching “${q}”`} hideCaption data-testid="admin-user-results">
              <thead>
                <tr>
                  <th scope="col">Handle</th>
                  <th scope="col">Email</th>
                  <th scope="col">Roles</th>
                  <th scope="col" className={styles.num}>
                    Brews
                  </th>
                  <th scope="col">Sign-in</th>
                </tr>
              </thead>
              <tbody>
                {users.data.map((user) => {
                  const lockedOut = isLockedOut(user.lockoutEnd, now);
                  return (
                    <tr key={user.id} data-testid="admin-user-row">
                      <th scope="row">
                        <Link className={styles.link} to={adminPaths.user(user.handle)}>
                          {user.handle}
                        </Link>
                      </th>
                      <td>
                        <span className={styles.mono}>{user.email ?? '—'}</span>{' '}
                        {user.email ? (
                          user.emailConfirmed ? (
                            <Pill tone="success">Confirmed</Pill>
                          ) : (
                            <Pill>Not confirmed</Pill>
                          )
                        ) : null}
                      </td>
                      <td>{user.roles.length > 0 ? user.roles.join(', ') : '—'}</td>
                      <td className={styles.num}>{formatCount(user.brewCount)}</td>
                      <td>
                        {lockedOut ? (
                          <Pill tone="danger">
                            Locked out until <Time value={user.lockoutEnd} />
                          </Pill>
                        ) : (
                          'Allowed'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </TableRegion>
          ) : null}
          {users.error && !fieldError ? (
            <QueryError error={users.error} what="the accounts" onRetry={() => void users.refetch()} />
          ) : users.isPending ? (
            <Loading>Searching…</Loading>
          ) : null}
        </section>
      ) : null}
    </AdminSection>
  );
}
