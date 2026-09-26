// /admin/users/:handle: one account (from the user search, exact handle) and every brew it has in
// any role, as the account itself sees them (GET /api/admin/users/{handle}/brews): unpublished,
// locked and invited ones included (port of upstream's admin author lookup).
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { normalizeHandle, type UserBrewList } from '@/api';
import { useAdminUserBrews, useAdminUsers } from '@/api/admin';
import { paths } from '@/app/paths';
import styles from './Admin.module.css';
import { formatCount, isLockedOut } from './adminModel';
import { Loading, Pill, QueryError, TableRegion, Time } from './adminParts';
import { adminPaths } from './adminPaths';
import { AdminSection } from './AdminSection';

export default function UserDetailPage() {
  const { handle = '' } = useParams();
  const wanted = normalizeHandle(handle);
  const users = useAdminUsers(wanted);
  const brews = useAdminUserBrews(wanted);
  const account = users.data?.find((user) => user.handle === wanted);
  const detailsId = useId();
  const brewsId = useId();
  const [now] = useState(() => Date.now());
  const lockedOut = isLockedOut(account?.lockoutEnd, now);

  return (
    <AdminSection title={`User ${handle}`} data-testid="admin-user">
      <p className={styles.text}>
        <Link className={styles.link} to={adminPaths.users(handle)}>
          Back to the account search
        </Link>
      </p>

      <section className={styles.card} aria-labelledby={detailsId}>
        <h2 id={detailsId} className={styles.cardTitle}>
          Account
        </h2>
        {account ? (
          <dl className={styles.facts} data-testid="admin-user-details">
            <div>
              <dt>Handle</dt>
              <dd>
                {account.handle} (
                <Link className={styles.link} to={paths.user(account.handle)}>
                  public brew list
                </Link>
                )
              </dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>
                <span className={styles.mono}>{account.email ?? '—'}</span>
                {account.email ? ` (${account.emailConfirmed ? 'confirmed' : 'not confirmed'})` : null}
              </dd>
            </div>
            <div>
              <dt>Roles</dt>
              <dd>{account.roles.length > 0 ? account.roles.join(', ') : 'None'}</dd>
            </div>
            <div>
              <dt>Brews</dt>
              <dd>{formatCount(account.brewCount)}</dd>
            </div>
            <div>
              <dt>Sign-in</dt>
              <dd>
                {lockedOut ? (
                  <>
                    Locked out after failed sign-ins until <Time value={account.lockoutEnd} />
                  </>
                ) : (
                  'Allowed'
                )}
              </dd>
            </div>
            <div>
              <dt>User id</dt>
              <dd className={styles.mono}>{account.id}</dd>
            </div>
          </dl>
        ) : users.error ? (
          <QueryError error={users.error} what="the account" onRetry={() => void users.refetch()} />
        ) : users.isPending ? (
          <Loading>Loading the account…</Loading>
        ) : (
          <p className={styles.empty} data-testid="admin-user-missing">
            No account has the handle “{wanted}”.
          </p>
        )}
      </section>

      <section className={styles.card} aria-labelledby={brewsId}>
        <h2 id={brewsId} className={styles.cardTitle}>
          Brews
        </h2>
        {brews.data ? (
          <UserBrewsTable list={brews.data} />
        ) : brews.error ? (
          brews.error.status === 404 ? (
            <p className={styles.empty}>No account has the handle “{wanted}”.</p>
          ) : (
            <QueryError error={brews.error} what="the brews" onRetry={() => void brews.refetch()} />
          )
        ) : (
          <Loading>Loading the brews…</Loading>
        )}
      </section>
    </AdminSection>
  );
}

function UserBrewsTable({ list }: { list: UserBrewList }) {
  if (list.items.length === 0) {
    return (
      <p className={styles.empty} data-testid="admin-user-brews-empty">
        {list.handle} has no brews.
      </p>
    );
  }
  return (
    <>
      <p className={styles.text} data-testid="admin-user-brew-count">
        {formatCount(list.total)} {list.total === 1 ? 'brew' : 'brews'}
        {list.items.length < list.total ? `, the first ${formatCount(list.items.length)} shown` : ''}. Unpublished, locked and invited brews are
        included.
      </p>
      <TableRegion caption={`Brews of ${list.handle}`} hideCaption data-testid="admin-user-brews">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Role</th>
            <th scope="col">State</th>
            <th scope="col" className={styles.num}>
              Views
            </th>
            <th scope="col">Updated</th>
            <th scope="col">Share page</th>
          </tr>
        </thead>
        <tbody>
          {list.items.map((brew) => (
            <tr key={brew.shareId} data-testid="admin-user-brew-row">
              <th scope="row">
                <Link className={styles.link} to={adminPaths.brew(brew.shareId)}>
                  {brew.title || 'Untitled brew'}
                </Link>
              </th>
              <td>{brew.role ?? '—'}</td>
              <td>
                <span className={styles.pills}>
                  {brew.published ? <Pill tone="success">Published</Pill> : <Pill>Unpublished</Pill>}
                  {brew.locked ? <Pill tone="danger">Locked</Pill> : null}
                </span>
              </td>
              <td className={styles.num}>{formatCount(brew.views)}</td>
              <td className={styles.nowrap}>
                <Time value={brew.updatedAt} relative />
              </td>
              <td>
                <Link className={`${styles.link} ${styles.mono}`} to={paths.share(brew.shareId)}>
                  {brew.shareId}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </TableRegion>
    </>
  );
}
