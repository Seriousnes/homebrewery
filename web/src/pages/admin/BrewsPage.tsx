// /admin/brews and /admin/brews/:id: brew lookup by share id, edit id or internal id (port of
// upstream's admin "Brew Lookup"), the brew's details, and its lock tools (LockPanel). Upstream's
// script cleaning has no counterpart: the server sanitizes every saved document.
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AdminBrewInfo } from '@/api';
import { useAdminBrew } from '@/api/admin';
import { paths } from '@/app/paths';
import { Button, TextField } from '@/ui';
import styles from './Admin.module.css';
import { formatCount, yesNo } from './adminModel';
import { Loading, Pill, QueryError, Time } from './adminParts';
import { adminPaths } from './adminPaths';
import { AdminSection } from './AdminSection';
import { LockPanel } from './LockPanel';

export default function BrewsPage() {
  const { id: rawId = '' } = useParams();
  const id = rawId.trim();
  const navigate = useNavigate();
  // The central policy: a 404 (no such brew) shows no toast; 401 asks to sign in.
  const brew = useAdminBrew(id, { meta: { errorPolicy: 'auto' } });
  const [value, setValue] = useState(id);
  const [lastId, setLastId] = useState(id);
  const [inputError, setInputError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);

  if (id !== lastId) {
    setLastId(id);
    setValue(id);
    setInputError(undefined);
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = value.trim();
    if (!next) {
      setInputError('Enter a share id, edit id or internal id.');
      inputRef.current?.focus();
      return;
    }
    setInputError(undefined);
    if (next === id) void brew.refetch();
    else void navigate(adminPaths.brew(next));
  };

  const notFound = brew.error?.status === 404;

  return (
    <AdminSection title="Brews" lead="Look up a brew by its share id, edit id or internal id, then lock or unlock it." data-testid="admin-brews">
      <form className={styles.search} onSubmit={submit} noValidate role="search" aria-label="Look up a brew">
        <TextField
          ref={inputRef}
          className={styles.searchField}
          label="Share id, edit id or internal id"
          name="id"
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={value}
          error={inputError}
          onChange={(event) => {
            setValue(event.target.value);
            setInputError(undefined);
          }}
          data-testid="admin-brew-search"
        />
        <Button type="submit" variant="primary" icon="search" className={styles.searchButton} loading={brew.isFetching} data-testid="admin-brew-search-submit">
          Look up
        </Button>
      </form>

      {id ? (
        <>
          <p role="status" className={styles.srOnlyStatus} data-testid="admin-brew-status">
            {brew.data ? `Found “${brew.data.title || 'Untitled brew'}”.` : notFound ? `No brew has the id “${id}”.` : ''}
          </p>
          {brew.data ? (
            <>
              <BrewDetails brew={brew.data} />
              <LockPanel key={brew.data.shareId} brew={brew.data} />
            </>
          ) : notFound ? (
            <p className={styles.empty} data-testid="admin-brew-missing">
              No brew has the id “{id}”. Check the id: share ids and edit ids are 12 characters, internal ids are GUIDs.
            </p>
          ) : brew.error ? (
            <QueryError error={brew.error} what="the brew" onRetry={() => void brew.refetch()} />
          ) : (
            <Loading>Looking up the brew…</Loading>
          )}
        </>
      ) : null}
    </AdminSection>
  );
}

function BrewDetails({ brew }: { brew: AdminBrewInfo }) {
  const headingId = useId();
  const title = brew.title || 'Untitled brew';
  return (
    <section className={styles.card} aria-labelledby={headingId} data-testid="admin-brew-details">
      <div className={styles.cardHeader}>
        <h2 id={headingId} className={styles.cardTitle}>
          {title}
        </h2>
        <span className={styles.pills}>
          {brew.published ? <Pill tone="success">Published</Pill> : <Pill>Unpublished</Pill>}
          {brew.lock ? (
            <Pill tone="danger" data-testid="admin-brew-locked">
              Locked
            </Pill>
          ) : null}
          {brew.lock?.reviewRequested ? <Pill tone="warning">Review requested</Pill> : null}
        </span>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Share id</dt>
          <dd>
            <span className={styles.mono} data-testid="admin-brew-share-id">
              {brew.shareId}
            </span>{' '}
            (
            <Link className={styles.link} to={paths.share(brew.shareId)}>
              share page
            </Link>
            )
          </dd>
        </div>
        <div>
          <dt>Edit id</dt>
          <dd className={styles.mono} data-testid="admin-brew-edit-id">
            {brew.editId}
          </dd>
        </div>
        <div>
          <dt>Internal id</dt>
          <dd className={styles.mono}>{brew.id}</dd>
        </div>
        <div>
          <dt>Authors</dt>
          <dd data-testid="admin-brew-authors">
            {brew.authors.length === 0
              ? 'None'
              : brew.authors.map((author, index) => (
                  <span key={author.handle}>
                    {index > 0 ? ', ' : null}
                    <Link className={styles.link} to={adminPaths.user(author.handle)}>
                      {author.handle}
                    </Link>{' '}
                    ({author.role})
                  </span>
                ))}
          </dd>
        </div>
        {brew.description ? (
          <div>
            <dt>Description</dt>
            <dd className={styles.preLine}>{brew.description}</dd>
          </div>
        ) : null}
        {brew.tags.length > 0 ? (
          <div>
            <dt>Tags</dt>
            <dd>{brew.tags.join(', ')}</dd>
          </div>
        ) : null}
        <div>
          <dt>Theme and language</dt>
          <dd>
            {brew.theme}, {brew.lang}
          </dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd>{yesNo(brew.published)}</dd>
        </div>
        <div>
          <dt>Pages</dt>
          <dd>{formatCount(brew.pageCount)}</dd>
        </div>
        <div>
          <dt>Views</dt>
          <dd data-testid="admin-brew-views">{formatCount(brew.views)}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>
            {formatCount(brew.version)} (document schema {brew.docSchemaVersion})
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <Time value={brew.createdAt} />
          </dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>
            <Time value={brew.updatedAt} /> (<Time value={brew.updatedAt} relative />)
          </dd>
        </div>
        <div>
          <dt>Last viewed</dt>
          <dd>
            <Time value={brew.lastViewedAt} fallback="Never" />
          </dd>
        </div>
        {brew.thumbnailUrl ? (
          <div>
            <dt>Thumbnail</dt>
            <dd className={styles.mono}>{brew.thumbnailUrl}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
