// /new (plan §9, P7.2, issue #4): a new brew.
//
// Signed out, it is a local brew (web/src/pages/local): its first change stores it in this
// browser's local brew library and the page moves to /local/:localId with the same editor. Nothing
// goes to the cloud until the user signs in and uploads it. Signing in before typing anything
// turns the page into a signed-in /new.
//
// Signed in, its draft lives in IndexedDB (key 'new') and is loaded here, so it survives a reload.
// The first save POSTs, then the page moves to /edit/:editId with the same editor. A loaded draft
// is saved on the next edit; "Start over" discards it. Only its author gets a signed-in user's
// draft (SAVE-12); a draft an earlier /new session in this tab turned into a brew is not loaded
// again, and one whose create never answered continues that create chain (SAVE-8; newDraft.ts).
//
// Before local brews, a signed-out visitor's brew was the 'new' draft too, saved to the cloud at
// sign-in. Such a draft becomes a local brew here (migrateAnonymousNewDraft): signed out, /new then
// opens it at /local/:localId; signed in, a toast points to it.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { queryKeys, useMe } from '@/api';
import { PageLoading } from '@/app/PageLoading';
import { paths } from '@/app/paths';
import { formatRelativeTime } from '@/app/relativeTime';
import { LazyEditorApp } from '@/editor/EditorApp/LazyEditorApp';
import { appBrewForNew, blankDoc, docForEditor } from '@/editor/EditorApp/editorAppModel';
import { migrateAnonymousNewDraft } from '@/editor/local/localBrews';
import { CreateChainContext, createChainOf } from '@/editor/save/createChain';
import { type Draft, NEW_DRAFT_KEY, readDraft } from '@/editor/save/drafts';
import { pendingNewBrewCreates } from '@/editor/save/newBrewCreates';
import { defaultDraftStore } from '@/editor/save/stores';
import { draftDiscardedAt, localSessionId, type NewPageState } from '@/pages/edit/editorSession';
import { noteCreatedAfterLeaving } from '@/pages/edit/leftSession';
import { useMountedRef } from '@/pages/edit/useMountedRef';
import { LocalBrewEditor } from '@/pages/local/LocalBrewEditor';
import { Button, ConfirmDialog, Icon, toast } from '@/ui';
import styles from './NewBrewSession.module.css';
import { chooseNewDraft, waitForRunningCreates } from './newDraft';

export interface NewBrewSessionProps {
  sessionKey: string;
  /** Keep this session mounted for the created brew's /edit/:editId (a copy replaces `from`). */
  adopt: (sessionKey: string, editId: string, from?: string | null) => void;
}

interface LoadedDraft {
  kind: 'server';
  draft: Draft | null;
  /** Another user's draft, loaded if its owner signs in here before anything is typed (SAVE-12). */
  withheld: Draft | null;
  /** Bumped when the editor mounts again with another draft. */
  generation: number;
}

/** Signed out: a local brew (migrated: the earlier anonymous draft, now a local brew to open). */
interface LoadedLocal {
  kind: 'local';
  migrated: string | null;
}

export function NewBrewSession({ sessionKey, adopt }: NewBrewSessionProps) {
  const location = useLocation();
  const [discardedAt] = useState(() => draftDiscardedAt(location.state));
  const [loaded, setLoaded] = useState<LoadedDraft | LoadedLocal | null>(null);
  // The signed-out brew was edited (it is stored a moment later, then the URL moves to
  // /local/:localId): this session stays local even if the user signs in meanwhile.
  const storedLocal = useRef(false);
  const [waiting, setWaiting] = useState(false);
  // Bumped to load the page again (signed in on a signed-out /new before typing).
  const [reloads, setReloads] = useState(0);
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });
  // Who is signed in decides whose draft is loaded and whether it is saved at once: wait for it.
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const meReady = !me.isPending;
  const currentUser = me.data?.id ?? null;
  const userId = useRef<string | null>(null);
  useEffect(() => {
    userId.current = currentUser;
  });

  useEffect(() => {
    if (!meReady) return;
    let cancelled = false;
    void (async () => {
      // A /new session left a moment ago (e.g. "New brew" on a /new page with typed text) may still
      // be creating its brew from the 'new' draft (its unmount save): wait for that answer (SAVE-8).
      if (pendingNewBrewCreates().length) setWaiting(true);
      await waitForRunningCreates();
      const migrated = await migrateAnonymousNewDraft(defaultDraftStore()).catch(() => null);
      if (cancelled) return;
      if (userId.current === null) {
        setLoaded((previous) => previous ?? { kind: 'local', migrated });
        return;
      }
      if (migrated) {
        toast({
          title: 'Your earlier draft is on this device',
          description: 'It was kept as a local brew. Open “Brews on this device” to upload it to your account.',
          tone: 'info',
          action: { label: 'Open', onAction: () => void navigateRef.current(paths.localBrew(migrated)) },
        });
      }
      const stored = await readDraft(defaultDraftStore(), NEW_DRAFT_KEY).catch(() => null);
      if (cancelled) return;
      const choice = chooseNewDraft(stored, { discardedAt, userId: userId.current });
      setLoaded((previous) => previous ?? { kind: 'server', draft: choice.draft, withheld: choice.withheld, generation: 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [meReady, discardedAt, reloads]);

  // Signed in on a signed-out /new before anything was typed: load it again as a signed-in /new.
  useEffect(() => {
    if (loaded?.kind === 'local' && !loaded.migrated && !storedLocal.current && currentUser) {
      setLoaded(null);
      setReloads((n) => n + 1);
    }
  }, [loaded, currentUser]);

  // The withheld draft's owner signed in on this page: if the stored draft is still theirs (nothing
  // was typed here meanwhile), it comes back, saved on their next edit like any earlier draft.
  const withheld = loaded?.kind === 'server' ? loaded.withheld : null;
  useEffect(() => {
    if (!withheld || !currentUser || withheld.ownerId !== currentUser) return;
    let cancelled = false;
    void readDraft(defaultDraftStore(), NEW_DRAFT_KEY)
      .catch(() => null)
      .then((stored) => {
        if (cancelled) return;
        const unchanged = stored !== null && stored.updatedAt === withheld.updatedAt && stored.ownerId === currentUser;
        setLoaded((l) => {
          if (!l || l.kind !== 'server' || l.withheld !== withheld) return l;
          return unchanged ? { kind: 'server', draft: stored, withheld: null, generation: l.generation + 1 } : { ...l, withheld: null };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [withheld, currentUser]);

  if (!loaded) return <PageLoading label={waiting ? 'Saving your previous brew…' : 'Loading your draft…'} />;
  if (loaded.kind === 'local') {
    if (loaded.migrated) return <Navigate to={paths.localBrew(loaded.migrated)} replace />;
    return (
      <LocalBrewEditor
        brew={null}
        onEdited={() => {
          storedLocal.current = true;
        }}
        onStored={(localId) => {
          storedLocal.current = true;
          adopt(sessionKey, localSessionId(localId));
        }}
      />
    );
  }
  return <NewBrewEditor key={loaded.generation} draft={loaded.draft} sessionKey={sessionKey} adopt={adopt} />;
}

function NewBrewEditor({ draft, sessionKey, adopt }: { draft: Draft | null } & NewBrewSessionProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const mounted = useMountedRef();
  // The brew this session holds (none until the first save; a copy replaces it).
  const held = useRef<string | null>(null);
  const [initial] = useState(() => ({
    content: draft ? docForEditor(draft.doc, draft.docSchemaVersion) : blankDoc(),
    brew: appBrewForNew(draft),
    metaInput: draft?.meta ?? null,
    // The draft's create chain (SAVE-8): a POST that never answered is sent again with its key.
    chain: createChainOf(draft),
  }));
  const [created, setCreated] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // "Start over": this render turned autosave off (no flush of the old draft on unmount), then
  // the draft goes and a fresh /new mounts.
  useEffect(() => {
    if (!discarding) return;
    const at = Date.now();
    void defaultDraftStore()
      .del(NEW_DRAFT_KEY)
      .catch(() => undefined)
      .then(() => navigate(paths.new, { replace: true, state: { hbDraftDiscardedAt: at } satisfies NewPageState }));
  }, [discarding, navigate]);

  const signedIn = Boolean(me.data);

  const banner = created ? null : (
    <>
      {draft ? <DraftNotice draft={draft} waitsForEdit={signedIn} onStartOver={() => setConfirmOpen(true)} /> : null}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Start over?"
        message="This discards your unsaved draft on this device. It can't be undone."
        confirmLabel="Discard the draft"
        tone="danger"
        onConfirm={() => setDiscarding(true)}
      />
    </>
  );

  return (
    <CreateChainContext.Provider value={initial.chain}>
      <LazyEditorApp
        mode="edit"
        saving={discarding ? 'none' : 'server'}
        content={initial.content}
        brew={initial.brew}
        initialMetaInput={initial.metaInput}
        recent="edit"
        autoFocus
        heading={created ? (title) => `Editing ${title}` : 'New brew'}
        banner={banner}
        onCreated={(brew, reason) => {
          // The user left before the save landed (the unmount save): stay where they went.
          if (!mounted.current) {
            noteCreatedAfterLeaving(brew, reason);
            return;
          }
          setCreated(true);
          const from = held.current;
          held.current = brew.editId;
          adopt(sessionKey, brew.editId, from);
          // A copy: the original's URL loads it again (the cached original predates the conflict).
          if (from !== null && from !== brew.editId) queryClient.removeQueries({ queryKey: queryKeys.brews.edit(from), exact: true });
          void navigate(paths.edit(brew.editId), { replace: reason === 'new' });
        }}
        data-testid="editor-app"
      />
    </CreateChainContext.Provider>
  );
}

function DraftNotice({ draft, waitsForEdit, onStartOver }: { draft: Draft; waitsForEdit: boolean; onStartOver: () => void }) {
  const titleId = useId();
  return (
    <section className={styles.notice} aria-labelledby={titleId} data-testid="new-draft-notice">
      <Icon name="info" size={20} className={styles.icon} />
      <div className={styles.text}>
        <h2 id={titleId} className={styles.title}>
          Your unsaved draft
        </h2>
        <p className={styles.message}>
          You're continuing the draft this browser kept from {formatRelativeTime(draft.updatedAt)}.
          {waitsForEdit ? ' It is saved as a new brew when you edit it.' : ''}
        </p>
      </div>
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" icon="trash" onClick={onStartOver} data-testid="new-start-over">
          Start over
        </Button>
      </div>
    </section>
  );
}
