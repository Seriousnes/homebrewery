// /share/:shareId (plan §9, P7.1): the brew read-only, paginated, never saved. Loads without an
// account; the API counts a view unless the caller is one of its authors. A locked brew (423)
// shows the lock message page, 404 the not-found page. Authors get a link to the editor, other
// signed-in readers can clone it, anyone can print it.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { type AccountInfo, type BrewForShare, normalizeHandle, useBrewForShare, useCloneBrew, useMe } from '@/api';
import { PageLoading } from '@/app/PageLoading';
import { paths } from '@/app/paths';
import { EditorNavItems } from '@/editor/EditorApp/EditorNavItems';
import { LazyEditorApp } from '@/editor/EditorApp/LazyEditorApp';
import { appBrewFromShare, docForEditor, isOpenableVersion } from '@/editor/EditorApp/editorAppModel';
import { NewerVersionPage } from '@/pages/edit/NewerVersionPage';
import { ErrorPage } from '@/pages/errors';
import { NavButton } from '@/ported/navbar';
import { Icon } from '@/ui';
import styles from './SharePage.module.css';

export default function SharePage() {
  const { shareId } = useParams();
  const query = useBrewForShare(shareId);
  if (query.data && !isOpenableVersion(query.data.docSchemaVersion)) return <NewerVersionPage />;
  if (query.data) return <ShareView key={query.data.shareId} brew={query.data} onAuthorSignedIn={() => void query.refetch()} />;
  if (query.error) return <ErrorPage error={query.error} onRetry={() => void query.refetch()} />;
  return <PageLoading label="Loading the brew…" />;
}

const isAuthor = (brew: BrewForShare, account: AccountInfo | null | undefined): boolean =>
  account != null && brew.authors.some((handle) => normalizeHandle(handle) === normalizeHandle(account.handle));

const viewCount = new Intl.NumberFormat('en');

/**
 * `brew` is the live query data (the editor reads its first value once). The navbar items follow
 * who is signed in now: Edit for the brew's authors, Clone for other signed-in readers.
 */
function ShareView({ brew, onAuthorSignedIn }: { brew: BrewForShare; onAuthorSignedIn: () => void }) {
  const [initial] = useState(() => ({ content: docForEditor(brew.doc, brew.docSchemaVersion), brew: { ...appBrewFromShare(brew), editId: null } }));
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const author = isAuthor(brew, me.data);
  // An author signed in on this page: ask once more for the edit link (an author's visit counts no view).
  const needsEditId = author && brew.editId === null;
  useEffect(() => {
    if (needsEditId) onAuthorSignedIn();
    // Once per sign-in.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [needsEditId]);

  const navItems = !me.data ? null : author ? (
    brew.editId ? <EditorNavItems editId={brew.editId} /> : null
  ) : (
    <CloneNavItem shareId={brew.shareId} />
  );

  return (
    <LazyEditorApp
      mode="view"
      saving="none"
      content={initial.content}
      brew={initial.brew}
      recent="view"
      heading={(title) => title}
      navItems={navItems}
      statusNote={
        <span className={styles.views} data-testid="share-views">
          <Icon name="eye" />
          {`${viewCount.format(brew.views)} ${brew.views === 1 ? 'view' : 'views'}`}
        </span>
      }
      data-testid="share-view"
    />
  );
}

/** "Clone": a copy of the brew, owned by the reader (POST /api/brews/{shareId}/clone). */
function CloneNavItem({ shareId }: { shareId: string }) {
  const navigate = useNavigate();
  const clone = useCloneBrew({ onSuccess: (copy) => void navigate(paths.edit(copy.editId)) });
  return (
    <NavButton
      tone="blue"
      icon={<Icon name="copy" />}
      collapsible
      aria-busy={clone.isPending || undefined}
      disabled={clone.isPending}
      onClick={() => clone.mutate(shareId)}
      data-testid="nav-clone"
    >
      Clone
    </NavButton>
  );
}
