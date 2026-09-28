// /vault (plan §9, P7.3; port of legacy client/homebrew/pages/vaultPage): search the published,
// unlocked brews (GET /api/vault). The search box takes PostgreSQL websearch syntax ("a phrase",
// -exclude, or); an author filter (a handle) and the page size sit next to it. Sort, direction and
// page are links and buttons that change the URL (?q=&author=&sort=&dir=&page=&pageSize=), so
// every result page can be shared and Back works. Upstream required a title or an author before
// searching; here an empty search lists the most recently updated brews.
import { type FormEvent, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { describeApiError, useMe, useVaultSearch, type VaultSort } from '@/api';
import { SitePage } from '@/app/SitePage';
import { BrewItem } from '@/ported/brewItem/BrewItem';
import { useBrewActions } from '@/ported/brewItem/useBrewActions';
import { brewCount, formatCount } from '@/ported/listPage/listModel';
import { SortBar } from '@/ported/listPage/SortBar';
import { Button, Select, Spinner, TextField } from '@/ui';
import { Pagination } from './Pagination';
import {
  DEFAULT_PAGE_SIZE,
  effectiveDir,
  effectiveSort,
  MAX_QUERY_LENGTH,
  PAGE_SIZES,
  readVaultQuery,
  totalPages,
  VAULT_SORT_LABELS,
  VAULT_SORTS,
  type VaultQuery,
  vaultSearchParams,
  writeVaultQuery,
} from './vaultQuery';
import styles from './VaultPage.module.css';

const PAGE_SIZE_OPTIONS = PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }));

interface FormValues {
  q: string;
  author: string;
  pageSize: number;
}

const formValuesOf = (query: VaultQuery): FormValues => ({ q: query.q, author: query.author, pageSize: query.pageSize });

export default function VaultPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => readVaultQuery(searchParams), [searchParams]);
  const search = useVaultSearch(vaultSearchParams(query), { meta: { errorPolicy: 'manual' } });
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const { actionsFor, dialog } = useBrewActions({ signedIn: Boolean(me.data) });
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const resultsId = useId();

  // The form follows the URL (Back, Forward, a new link) but keeps what is typed until then.
  const urlForm = `${query.q}\n${query.author}\n${query.pageSize}`;
  const [form, setForm] = useState<FormValues>(() => formValuesOf(query));
  const [formSource, setFormSource] = useState(urlForm);
  if (formSource !== urlForm) {
    setFormSource(urlForm);
    setForm(formValuesOf(query));
  }

  const go = (next: VaultQuery) => setSearchParams(writeVaultQuery(next));
  const searchFor = (page: number) => `?${writeVaultQuery({ ...query, page }).toString()}`;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = { ...query, q: form.q.trim(), author: form.author.trim(), pageSize: form.pageSize, page: 1 };
    if (writeVaultQuery(next).toString() === searchParams.toString()) void search.refetch();
    else go(next);
  };
  const filtered = query.q.trim() !== '' || query.author.trim() !== '';

  const sort = effectiveSort(query);
  const dir = effectiveDir(sort, query.dir);
  const sortOptions = VAULT_SORTS.filter((s) => s !== 'relevance' || query.q.trim() !== '').map((value) => ({ value, label: VAULT_SORT_LABELS[value] }));

  const data = search.data;
  const error = search.error;
  const qMessage = error?.fieldError('q');
  const qError = qMessage ? (qMessage.startsWith('must ') ? `The search ${qMessage}.` : qMessage) : undefined;
  const pages = data ? totalPages(data.total, data.pageSize || query.pageSize) : 1;
  const page = data?.page ?? query.page;

  let status: string;
  if (error) status = qError ? 'Check the search.' : "Couldn't search the vault.";
  else if (!data) status = 'Searching…';
  else if (data.total === 0) status = 'No brews found.';
  else status = `${brewCount(data.total)} found.${pages > 1 ? ` Page ${formatCount(page)} of ${formatCount(pages)}.` : ''}`;

  return (
    <SitePage title="Vault" lead="Search the published brews." width="wide" data-testid="vault-page">
      <div className={styles.layout}>
        <form role="search" aria-label="Vault search" className={styles.form} onSubmit={onSubmit} noValidate data-testid="vault-form">
          <TextField
            type="search"
            name="q"
            label="Search"
            hint="Words in titles, descriptions and brew text."
            error={qError}
            value={form.q}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(event) => setForm({ ...form, q: event.target.value })}
            autoComplete="off"
            data-testid="vault-q"
          />
          <TextField
            name="author"
            label="Author"
            hint="A user's handle."
            value={form.author}
            onChange={(event) => setForm({ ...form, author: event.target.value })}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-testid="vault-author"
          />
          <Select
            name="pageSize"
            label="Results per page"
            options={PAGE_SIZE_OPTIONS}
            value={String(PAGE_SIZES.includes(form.pageSize as (typeof PAGE_SIZES)[number]) ? form.pageSize : DEFAULT_PAGE_SIZE)}
            onChange={(event) => setForm({ ...form, pageSize: Number(event.target.value) })}
            data-testid="vault-page-size"
          />
          <div className={styles.formActions}>
            <Button type="submit" variant="primary" icon="search" data-testid="vault-submit">
              Search
            </Button>
            {filtered ? (
              <Button
                type="button"
                variant="ghost"
                icon="close"
                onClick={() => go({ ...query, q: '', author: '', sort: null, dir: null, page: 1 })}
                data-testid="vault-clear"
              >
                Clear
              </Button>
            ) : null}
          </div>
          <div className={styles.tips}>
            <h2 className={styles.tipsHeading}>Search tips</h2>
            <ul>
              <li>Only published brews are listed.</li>
              <li>
                Whole words match: <code>dragon</code> doesn&apos;t find <code>dragons</code>.
              </li>
              <li>
                Quotes find a phrase: <code>&quot;fire giant&quot;</code>.
              </li>
              <li>
                A minus leaves a word out: <code>dragon -red</code>.
              </li>
              <li>
                <code>or</code> finds either word: <code>kobold or goblin</code>.
              </li>
            </ul>
          </div>
        </form>

        <section className={styles.results} aria-labelledby={resultsId} aria-busy={search.isFetching || undefined} data-testid="vault-results">
          <div className={styles.resultsHead}>
            <h2 id={resultsId} ref={resultsRef} tabIndex={-1} className={styles.resultsHeading}>
              Results
            </h2>
            <SortBar<VaultSort>
              options={sortOptions}
              sort={sort}
              dir={dir}
              defaultDir={(s) => effectiveDir(s, null)}
              onChange={(s, d) => go({ ...query, sort: s, dir: d, page: 1 })}
              data-testid="vault-sort"
            />
          </div>
          <p className={styles.status} role="status" data-testid="vault-status">
            {search.isFetching && data ? <Spinner size={14} decorative /> : null}
            {status}
          </p>

          {error ? (
            <div className={styles.problem} role="alert" data-testid="vault-error">
              {qError ? (
                <p>Fix the search above and try again.</p>
              ) : (
                <>
                  <p>{describeApiError(error)}</p>
                  <Button icon="redo" onClick={() => void search.refetch()} data-testid="vault-retry">
                    Try again
                  </Button>
                </>
              )}
            </div>
          ) : !data ? (
            <div className={styles.loading}>
              <Spinner size={24} decorative />
            </div>
          ) : data.items.length === 0 ? (
            <div className={styles.empty} data-testid="vault-empty">
              {data.total === 0 ? (
                <p>
                  {filtered
                    ? "No published brew matches. Try fewer or different words, or check the author's handle."
                    : 'There are no published brews yet.'}
                </p>
              ) : (
                <p>{`There is nothing on page ${formatCount(query.page)}; the results end on page ${formatCount(pages)}.`}</p>
              )}
            </div>
          ) : (
            <ul className={styles.items} data-testid="vault-items">
              {data.items.map((brew) => (
                <li key={brew.shareId} className={styles.itemCell}>
                  <BrewItem brew={brew} actions={actionsFor(brew)} />
                </li>
              ))}
            </ul>
          )}

          {data && !error ? (
            <Pagination page={page} pages={pages} searchFor={searchFor} onNavigate={() => resultsRef.current?.focus()} />
          ) : null}
        </section>
      </div>
      {dialog}
    </SitePage>
  );
}
