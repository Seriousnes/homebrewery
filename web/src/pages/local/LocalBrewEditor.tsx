// The editor of a local brew (issue #4): /local/:localId, and /new for a signed-out user, whose
// first change stores the brew and moves the URL to /local/:localId without remounting (the editor
// route adopts the id; see web/src/pages/edit/editorSession.ts). Signed in, "Upload" in the toolbar
// saves it to the account and opens it at /edit/:editId; it then leaves this device.
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, requestSignIn, useMe } from '@/api';
import { locationPath, paths } from '@/app/paths';
import type { EditorAppLocalBrew } from '@/editor/EditorApp/EditorApp';
import { LazyEditorApp } from '@/editor/EditorApp/LazyEditorApp';
import { appBrewForLocal, blankDoc, displayTitle, docForEditor } from '@/editor/EditorApp/editorAppModel';
import type { LocalBrew } from '@/editor/local/localBrews';
import { uploadLocalBrew, uploadProblem } from '@/editor/local/upload';
import { seedCreatedBrew } from '@/editor/save/cache';
import { Button, Icon, IconButton, toast } from '@/ui';
import styles from './local.module.css';

export interface LocalBrewEditorProps {
  /** The stored brew, or null for a new one. */
  brew: LocalBrew | null;
  /** A new brew was stored under `localId` (before the URL moves to it). */
  onStored?: (localId: string) => void;
}

export function LocalBrewEditor({ brew, onStored }: LocalBrewEditorProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const signedOut = me.isSuccess && !me.data;
  const [initial] = useState(() => ({
    content: brew ? docForEditor(brew.doc, brew.docSchemaVersion) : blankDoc(),
    brew: appBrewForLocal(brew),
  }));

  const local: EditorAppLocalBrew = {
    id: brew?.id ?? null,
    createdAt: brew?.createdAt ?? null,
    updatedAt: brew?.updatedAt ?? null,
    sourceMarkdown: brew?.sourceMarkdown ?? null,
    onCreated: (localId) => {
      onStored?.(localId);
      void navigate(paths.localBrew(localId), { replace: true });
    },
    onUpload: async (localId) => {
      try {
        const created = await uploadLocalBrew(localId);
        seedCreatedBrew(queryClient, created);
        toast({ title: 'Uploaded to your account', description: `“${displayTitle(created.meta.title)}” is saved in the cloud now.`, tone: 'success' });
        void navigate(paths.edit(created.editId), { replace: true });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) requestSignIn(error);
        else toast({ title: 'Couldn’t upload the brew', description: `${uploadProblem(error)} It is still on this device.`, tone: 'error' });
        throw error;
      }
    },
  };

  return (
    <LazyEditorApp
      mode="edit"
      saving="local"
      local={local}
      content={initial.content}
      brew={initial.brew}
      autoFocus
      heading={brew ? (title) => `Editing ${title}` : 'New brew'}
      banner={signedOut ? <LocalNotice /> : null}
      data-testid="editor-app"
    />
  );
}

const NOTICE_DISMISSED_KEY = 'hb-local-notice-dismissed';

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(NOTICE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** For signed-out users: where the brew is kept, and how to keep it in the cloud. Dismissed per tab. */
function LocalNotice() {
  const location = useLocation();
  const titleId = useId();
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(NOTICE_DISMISSED_KEY, '1');
    } catch {
      // Blocked storage: it comes back on the next page.
    }
  };
  return (
    <section className={styles.notice} aria-labelledby={titleId} data-testid="local-notice">
      <Icon name="device" size={20} className={styles.icon} />
      <div className={styles.text}>
        <h2 id={titleId} className={styles.title}>
          Saved in this browser
        </h2>
        <p className={styles.message}>
          No account needed. Your brews stay on this device (<Link className={styles.link} to={paths.local}>Brews on this device</Link>). Sign in or create an
          account to upload them to the cloud and share them.
        </p>
      </div>
      <div className={styles.actions}>
        <Button size="sm" variant="primary" onClick={() => requestSignIn(null)} data-testid="local-notice-sign-in">
          Sign in
        </Button>
        <Link className={styles.link} to={paths.register(locationPath(location))}>
          Create an account
        </Link>
        <IconButton icon="close" label="Dismiss" size="sm" onClick={dismiss} />
      </div>
    </section>
  );
}
