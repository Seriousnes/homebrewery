// /user/:handle (plan §9, P7.3; port of legacy client/homebrew/pages/userPage): a user's brews from
// GET /api/users/{handle}/brews (at most 1000, one request), sorted and filtered in the browser as
// upstream did. Other people see the published brews; the user also sees the unpublished ones and
// the brews they are invited to edit, with Edit, Download and Delete/Remove/Decline. The sort,
// direction, text filter and tag filters live in the URL (?sort=&dir=&filter=&tag=); the last sort
// and the closed groups are remembered per browser.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { type BrewSummary, normalizeHandle, queryKeys, type UserBrewList, useMe, useUserBrews } from '@/api';
import { PageLoading } from '@/app/PageLoading';
import { paths } from '@/app/paths';
import { SitePage } from '@/app/SitePage';
import { ErrorPage } from '@/pages/errors';
import { BrewItem } from '@/ported/brewItem/BrewItem';
import { useBrewActions } from '@/ported/brewItem/useBrewActions';
import { brewCount, formatCount, groupUserBrews, type ListState, possessive, readListQuery, toggleTag, writeListQuery } from '@/ported/listPage/listModel';
import { ListPage } from '@/ported/listPage/ListPage';
import listStyles from '@/ported/listPage/ListPage.module.css';
import { listPrefsStore, setGroupCollapsed, setSortPrefs, useListPrefs } from '@/ported/listPage/listPrefs';
import styles from './UserPage.module.css';

export default function UserPage() {
  const { handle = '' } = useParams();
  // Another user's page is a fresh list (its own filter state).
  return <UserBrews key={normalizeHandle(handle)} handle={handle} />;
}

function UserBrews({ handle }: { handle: string }) {
  const query = useUserBrews(handle);
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  if (query.data) return <UserBrewsList list={query.data} signedIn={Boolean(me.data)} />;
  if (query.error) {
    if (query.error.status === 404) {
      return <ErrorPage error={query.error} title="User not found" message={`No one has the handle “${handle}”. Check the link, or search the vault.`} />;
    }
    return <ErrorPage error={query.error} onRetry={() => void query.refetch()} />;
  }
  return (
    <SitePage title={`${possessive(handle)} brews`} width="wide">
      <PageLoading label="Loading brews…" />
    </SitePage>
  );
}

/** How many of the page's own URL writes are remembered (typing writes one per keystroke). */
const WRITTEN_URLS = 32;

function UserBrewsList({ list, signedIn }: { list: UserBrewList; signedIn: boolean }) {
  const prefs = useListPrefs();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<ListState>(() => readListQuery(searchParams, prefs));
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupUserBrews(list), [list]);

  // The state follows the URL when something else changes it (a "My brews" link, Back to a page
  // with other filters), but not when the URL is this page's own write arriving (the router
  // applies navigations in a transition, so a quick typist's older writes can land later).
  const urlKey = searchParams.toString();
  const written = useRef<string[]>([urlKey]);
  useEffect(() => {
    if (written.current.includes(urlKey)) return;
    written.current = [urlKey];
    setState(readListQuery(new URLSearchParams(urlKey), listPrefsStore().get()));
  }, [urlKey]);

  const update = (next: ListState) => {
    setState(next);
    if (next.sort !== state.sort || next.dir !== state.dir) setSortPrefs({ sort: next.sort, dir: next.dir });
    const params = writeListQuery(searchParams, next);
    written.current = [...written.current.slice(1 - WRITTEN_URLS), params.toString()];
    setSearchParams(params, { replace: true });
  };

  const { actionsFor, dialog } = useBrewActions({
    signedIn,
    // The list is refetched by the delete; drop the brew at once too, in case that refetch fails.
    onRemoved: (brew) =>
      queryClient.setQueryData<UserBrewList>(queryKeys.users.brews(list.handle), (old) =>
        old && old.items.some((b) => b.shareId === brew.shareId)
          ? { ...old, items: old.items.filter((b) => b.shareId !== brew.shareId), total: Math.max(0, old.total - 1) }
          : old,
      ),
    focusAfterRemoval: (brew) => focusNeighbour(listRef.current, brew),
  });

  const title = list.own ? 'Your brews' : `${possessive(list.handle)} brews`;
  const capped = list.total > list.items.length;

  return (
    <SitePage title={title} width="wide" lead={list.own ? 'Other people see your published brews here. Unpublished brews and invitations are visible only to you.' : undefined} data-testid="user-page">
      <div ref={listRef}>
        <ListPage
          groups={groups}
          state={state}
          onStateChange={update}
          collapsed={prefs.collapsed}
          onToggleGroup={setGroupCollapsed}
          renderItem={(brew: BrewSummary) => (
            <BrewItem brew={brew} onTagClick={(tag) => update({ ...state, tags: toggleTag(state.tags, tag) })} selectedTags={state.tags} actions={actionsFor(brew)} />
          )}
        >
          {capped ? (
            <p className={listStyles.note} data-testid="list-capped">
              {`Only the ${brewCount(list.items.length)} updated most recently are listed here, of ${formatCount(list.total)}.`}
            </p>
          ) : null}
          {list.own && list.items.length === 0 ? (
            <div className={styles.welcome} data-testid="list-no-brews">
              <p>You haven&apos;t made any brews yet.</p>
              <p className={styles.welcomeLinks}>
                <Link className={styles.link} to={paths.new}>
                  Create a brew
                </Link>
                <Link className={styles.link} to={paths.import}>
                  Import a brew
                </Link>
              </p>
            </div>
          ) : null}
        </ListPage>
      </div>
      {dialog}
    </SitePage>
  );
}


/**
 * Where focus goes once `brew` has left the list: the next brew's title link (or the previous
 * one), else its group's heading button.
 */
function focusNeighbour(root: HTMLElement | null, brew: BrewSummary): (() => void) | null {
  if (!root) return null;
  const links = Array.from(root.querySelectorAll<HTMLElement>('[data-brew-focus]'));
  const index = links.findIndex((el) => el.dataset.brewFocus === brew.shareId);
  const neighbour = links[index + 1] ?? links[index - 1];
  const neighbourId = index >= 0 ? neighbour?.dataset.brewFocus : undefined;
  const groupId = links[index]?.closest<HTMLElement>('[data-group]')?.dataset.group;
  return () => {
    const target =
      (neighbourId ? Array.from(root.querySelectorAll<HTMLElement>('[data-brew-focus]')).find((el) => el.dataset.brewFocus === neighbourId) : undefined) ??
      Array.from(root.querySelectorAll<HTMLElement>('[data-group-toggle]')).find((el) => el.dataset.groupToggle === groupId) ??
      root.querySelector<HTMLElement>('[data-group-toggle]');
    target?.focus();
  };
}
