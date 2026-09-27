// /local, "Brews on this device" (issue #4): the local brew library of this browser. Anyone can
// open, download as PDF and delete its brews; a signed-in user uploads them to their account, one
// at a time or all at once (they then leave this device). The list follows changes made in this
// tab and refreshes when the page is shown again (another tab may have changed it).
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, queryKeys, requestSignIn, useMe } from '@/api';
import { paths } from '@/app/paths';
import { formatRelativeTime } from '@/app/relativeTime';
import { SitePage } from '@/app/SitePage';
import { displayTitle } from '@/editor/EditorApp/editorAppModel';
import { EXPORT_TOAST_ID, exportFailure, exportSummary } from '@/editor/export/exportSummary';
import { defaultLocalBrews, type LocalBrewSummary, migrateAnonymousNewDraft, onLocalBrewsChanged } from '@/editor/local/localBrews';
import { uploadLocalBrew, uploadLocalBrews, uploadProblem } from '@/editor/local/upload';
import { defaultDraftStore } from '@/editor/save/stores';
import { Button, ConfirmDialog, Icon, Spinner, toast } from '@/ui';
import styles from './local.module.css';

type Listing = { state: 'loading' } | { state: 'ready'; brews: LocalBrewSummary[] } | { state: 'error'; error: unknown };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The local brews, kept up to date. */
function useLocalBrewList(): { listing: Listing; refresh: () => void } {
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const refresh = useCallback(() => {
    void defaultLocalBrews()
      .list()
      .then(
        (brews) => setListing({ state: 'ready', brews }),
        (error: unknown) => setListing({ state: 'error', error }),
      );
  }, []);
  useEffect(() => {
    // The anonymous /new draft of earlier versions is a local brew too.
    void migrateAnonymousNewDraft(defaultDraftStore())
      .catch(() => null)
      .then(refresh);
    const stop = onLocalBrewsChanged(refresh);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return { listing, refresh };
}

export default function LocalBrewsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const signedIn = Boolean(me.data);
  const { listing, refresh } = useLocalBrewList();
  const [busy, setBusy] = useState<Record<string, 'pdf' | 'upload'>>({});
  const [uploadingAll, setUploadingAll] = useState(false);
  const [deleting, setDeleting] = useState<LocalBrewSummary | null>(null);
  const persistent = defaultLocalBrews().persistent();

  const setBusyFor = (id: string, what: 'pdf' | 'upload' | null) =>
    setBusy((b) => {
      const next = { ...b };
      if (what) next[id] = what;
      else delete next[id];
      return next;
    });

  const afterUpload = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
  };

  const uploadOne = async (brew: LocalBrewSummary) => {
    if (busy[brew.id]) return;
    setBusyFor(brew.id, 'upload');
    try {
      const created = await uploadLocalBrew(brew.id);
      afterUpload();
      toast({
        title: 'Uploaded to your account',
        description: `“${displayTitle(created.meta.title)}” is saved in the cloud now.`,
        tone: 'success',
        action: { label: 'Open', onAction: () => void navigate(paths.edit(created.editId)) },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) requestSignIn(error);
      else toast({ title: 'Couldn’t upload the brew', description: `${uploadProblem(error)} It is still on this device.`, tone: 'error' });
    } finally {
      setBusyFor(brew.id, null);
      refresh();
    }
  };

  const uploadAll = async () => {
    if (listing.state !== 'ready' || uploadingAll) return;
    setUploadingAll(true);
    try {
      const result = await uploadLocalBrews(listing.brews.map((b) => b.id));
      afterUpload();
      const signedOut = result.failed.find((f) => f.error instanceof ApiError && f.error.status === 401);
      if (signedOut) requestSignIn(signedOut.error as ApiError);
      if (result.failed.length === 0) {
        toast({ title: `Uploaded ${plural(result.uploaded.length, 'brew', 'brews')}`, description: 'They are in your account now.', tone: 'success' });
      } else {
        toast({
          title: `Uploaded ${result.uploaded.length} of ${result.uploaded.length + result.failed.length}`,
          description: `${plural(result.failed.length, 'brew stays', 'brews stay')} on this device: ${uploadProblem(result.failed[0]!.error)}`,
          tone: 'warning',
        });
      }
    } finally {
      setUploadingAll(false);
      refresh();
    }
  };

  const downloadPdf = async (brew: LocalBrewSummary) => {
    if (busy[brew.id]) return;
    setBusyFor(brew.id, 'pdf');
    try {
      const stored = await defaultLocalBrews().get(brew.id);
      if (!stored) throw new Error('This brew is no longer on this device.');
      const exporter = await import('@/editor/export');
      const result = await exporter.exportStoredBrewPdf(stored, { title: displayTitle(stored.meta.title) });
      exporter.downloadFile(result.pdf, result.filename);
      toast({ id: EXPORT_TOAST_ID, ...exportSummary(result, exporter.formatBytes) });
    } catch (error) {
      toast({ id: EXPORT_TOAST_ID, ...exportFailure(error) });
    } finally {
      setBusyFor(brew.id, null);
    }
  };

  const brews = listing.state === 'ready' ? listing.brews : [];

  return (
    <SitePage
      title="Brews on this device"
      lead="Brews made in this browser without uploading them. Only this browser has them: clearing its site data deletes them."
      data-testid="local-brews-page"
    >
      {!persistent ? (
        <p className={styles.warning} role="note" data-testid="local-not-kept">
          <Icon name="warning" size={16} />
          This browser doesn’t let the site keep data (a private window, or blocked site data). Brews made here are lost when the page
          closes.
        </p>
      ) : null}

      <div className={styles.toolbar}>
        {signedIn ? (
          brews.length ? (
            <Button variant="primary" icon="upload" loading={uploadingAll} onClick={() => void uploadAll()} data-testid="local-upload-all">
              Upload all to my account
            </Button>
          ) : null
        ) : (
          <p className={styles.pageText}>
            <Button size="sm" variant="ghost" icon="user" onClick={() => requestSignIn(null)} data-testid="local-page-sign-in">
              Sign in
            </Button>{' '}
            or{' '}
            <Link className={styles.link} to={paths.register(paths.local)}>
              create an account
            </Link>{' '}
            to upload them to the cloud, publish and share them.
          </p>
        )}
        <Link className={styles.link} to={paths.new}>
          New brew
        </Link>
      </div>

      {listing.state === 'loading' ? <Spinner label="Loading the brews on this device" /> : null}
      {listing.state === 'error' ? (
        <p className={styles.warning} role="alert">
          Couldn’t read this browser’s storage. <Button size="sm" variant="ghost" onClick={refresh}>Try again</Button>
        </p>
      ) : null}
      {listing.state === 'ready' && brews.length === 0 ? (
        <p className={styles.pageText} data-testid="local-empty">
          No brews on this device. <Link className={styles.link} to={paths.new}>Create a brew</Link> or{' '}
          <Link className={styles.link} to={paths.import}>import one</Link>; no account needed.
        </p>
      ) : null}

      {brews.length ? (
        <ul className={styles.list} aria-label="Brews on this device" data-testid="local-brew-list">
          {brews.map((brew) => {
            const title = displayTitle(brew.title);
            return (
              <li key={brew.id} className={styles.item} data-testid="local-brew-item" data-local-id={brew.id}>
                <div className={styles.itemText}>
                  <Link className={styles.itemTitle} to={paths.localBrew(brew.id)}>
                    {title}
                  </Link>
                  <span className={styles.itemMeta}>
                    {plural(brew.pages, 'page', 'pages')} · edited {formatRelativeTime(brew.updatedAt)}
                  </span>
                </div>
                <div className={styles.itemActions}>
                  <Button size="sm" variant="ghost" icon="download" loading={busy[brew.id] === 'pdf'} onClick={() => void downloadPdf(brew)} aria-label={`Download ${title} as PDF`}>
                    PDF
                  </Button>
                  {signedIn ? (
                    <Button size="sm" variant="secondary" icon="upload" loading={busy[brew.id] === 'upload' || uploadingAll} onClick={() => void uploadOne(brew)} aria-label={`Upload ${title} to my account`} data-testid="local-brew-upload">
                      Upload
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setDeleting(brew)} aria-label={`Delete ${title}`} data-testid="local-brew-delete">
                    Delete
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete “${deleting ? displayTitle(deleting.title) : ''}”?`}
        message="It is only on this device, so it is gone for good. Download a PDF first if you want to keep a copy."
        confirmLabel="Delete brew"
        tone="danger"
        onConfirm={async () => {
          if (!deleting) return;
          await defaultLocalBrews().remove(deleting.id);
          toast({ title: `“${displayTitle(deleting.title)}” was deleted.`, tone: 'success' });
        }}
      />
    </SitePage>
  );
}
