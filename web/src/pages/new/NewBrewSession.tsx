// /new (plan §9, P7.2): a new brew. Its draft lives in IndexedDB (key 'new') and is loaded here,
// so it survives a reload and the sign-in redirect. Saving needs an account (plan §1): the first
// save POSTs, then the page moves to /edit/:editId with the same editor. A draft loaded here is
// saved as soon as its signed-out author signs in (signInHandoff.ts); an older one is shown and
// saved on the next edit. "Start over" discards it. Only its author gets a signed-in user's draft
// (SAVE-12); a draft an earlier /new session in this tab turned into a brew is not loaded again,
// and one whose create never answered continues that create chain (SAVE-8; newDraft.ts).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { queryKeys, requestSignIn, useMe } from '@/api';
import { PageLoading } from '@/app/PageLoading';
import { locationPath, paths } from '@/app/paths';
import { formatRelativeTime } from '@/app/relativeTime';
import { LazyEditorApp } from '@/editor/EditorApp/LazyEditorApp';
import { appBrewForNew, blankDoc, docForEditor } from '@/editor/EditorApp/editorAppModel';
import { CreateChainContext, createChainOf } from '@/editor/save/createChain';
import { type Draft, NEW_DRAFT_KEY, readDraft } from '@/editor/save/drafts';
import { pendingNewBrewCreates } from '@/editor/save/newBrewCreates';
import { defaultDraftStore } from '@/editor/save/stores';
import { draftDiscardedAt, type NewPageState } from '@/pages/edit/editorSession';
import { noteCreatedAfterLeaving } from '@/pages/edit/leftSession';
import { useMountedRef } from '@/pages/edit/useMountedRef';
import { Button, ConfirmDialog, Icon } from '@/ui';
import styles from './NewBrewSession.module.css';
import { chooseNewDraft, waitForRunningCreates } from './newDraft';
import { markAwaitingSignIn, saveLoadedDraft } from './signInHandoff';

export interface NewBrewSessionProps {
  sessionKey: string;
  /** Keep this session mounted for the created brew's /edit/:editId (a copy replaces `from`). */
  adopt: (sessionKey: string, editId: string, from?: string | null) => void;
}

interface LoadedDraft {
  draft: Draft | null;
  saveOnLoad: boolean;
  /** Another user's draft, loaded if its owner signs in here before anything is typed (SAVE-12). */
  withheld: Draft | null;
  /** Bumped when the editor mounts again with another draft. */
  generation: number;
}

export function NewBrewSession({ sessionKey, adopt }: NewBrewSessionProps) {
  const location = useLocation();
  const [discardedAt] = useState(() => draftDiscardedAt(location.state));
  const [loaded, setLoaded] = useState<LoadedDraft | null>(null);
  const [waiting, setWaiting] = useState(false);
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
      const stored = await readDraft(defaultDraftStore(), NEW_DRAFT_KEY).catch(() => null);
      if (cancelled) return;
      const choice = chooseNewDraft(stored, { discardedAt, userId: userId.current });
      const saveOnLoad = saveLoadedDraft(choice.draft !== null, userId.current !== null);
      setLoaded((previous) => previous ?? { draft: choice.draft, saveOnLoad, withheld: choice.withheld, generation: 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [meReady, discardedAt]);

  // The withheld draft's owner signed in on this page: if the stored draft is still theirs (nothing
  // was typed here meanwhile), it comes back, saved on their next edit like any earlier draft.
  const withheld = loaded?.withheld ?? null;
  useEffect(() => {
    if (!withheld || !currentUser || withheld.ownerId !== currentUser) return;
    let cancelled = false;
    void readDraft(defaultDraftStore(), NEW_DRAFT_KEY)
      .catch(() => null)
      .then((stored) => {
        if (cancelled) return;
        const unchanged = stored !== null && stored.updatedAt === withheld.updatedAt && stored.ownerId === currentUser;
        setLoaded((l) => {
          if (!l || l.withheld !== withheld) return l;
          return unchanged ? { draft: stored, saveOnLoad: false, withheld: null, generation: l.generation + 1 } : { ...l, withheld: null };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [withheld, currentUser]);

  if (!loaded) return <PageLoading label={waiting ? 'Saving your previous brew…' : 'Loading your draft…'} />;
  return (
    <NewBrewEditor key={loaded.generation} draft={loaded.draft} saveOnLoad={loaded.saveOnLoad} sessionKey={sessionKey} adopt={adopt} />
  );
}

function NewBrewEditor({ draft, saveOnLoad, sessionKey, adopt }: { draft: Draft | null; saveOnLoad: boolean } & NewBrewSessionProps) {
  const navigate = useNavigate();
  const location = useLocation();
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
  // A signed-out visitor's draft waits for their sign-in (also through the sign-in page).
  const anonymous = me.isSuccess && !signedIn;
  useEffect(() => {
    if (anonymous && !created) markAwaitingSignIn();
  }, [anonymous, created]);

  const banner = created ? null : (
    <>
      {anonymous ? <SignInNotice returnTo={locationPath(location)} /> : null}
      {draft ? <DraftNotice draft={draft} waitsForEdit={signedIn && !saveOnLoad} onStartOver={() => setConfirmOpen(true)} /> : null}
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
        unsavedOnLoad={saveOnLoad}
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

function SignInNotice({ returnTo }: { returnTo: string }) {
  const titleId = useId();
  return (
    <section className={styles.notice} aria-labelledby={titleId} data-testid="new-sign-in-notice">
      <Icon name="user" size={20} className={styles.icon} />
      <div className={styles.text}>
        <h2 id={titleId} className={styles.title}>
          Sign in to save
        </h2>
        <p className={styles.message}>Your brew is kept in this browser until you sign in; then it is saved to your account.</p>
      </div>
      <div className={styles.actions}>
        <Button size="sm" variant="primary" onClick={() => requestSignIn(null)} data-testid="new-sign-in">
          Sign in
        </Button>
        <Link className={styles.link} to={paths.register(returnTo)}>
          Create an account
        </Link>
      </div>
    </section>
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
