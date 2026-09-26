// /import (plan §7, §9, P6.1 and P6.3): bring a brew from the Homebrewery.
//
//   1. Choose the brew   paste its text, upload its .txt/.md file, or paste its share link (the
//                        API's proxy downloads it: sign-in required)
//   2. Check the import  hbfmToDoc runs here (convert.ts, loaded on demand); the import report and a
//                        read-only paginated preview with the brew's theme are shown BEFORE anything
//                        is saved. Once the preview has laid the pages out, the report says how many
//                        pages the clipped ones grew into (recordPaginatedPages).
//   3. Create the brew   POST /api/brews (doc, style, snippets, meta, sourceMarkdown), then /edit/:editId.
//                        Signed-out visitors get the sign-in dialog; the page keeps its state, and
//                        sessionStorage keeps the text if they go to the sign-in or register page.
import type { JSONContent } from '@tiptap/core';
import { type ChangeEvent, type ComponentType, type ReactNode, useCallback, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { type ApiError, isApiError, queryKeys, requestSignIn, useCreateBrew, useMe, useUpstreamImport } from '@/api';
import { paths } from '@/app/paths';
import { SitePage } from '@/app/SitePage';
import { recordPaginatedPages, type ImportReportData } from '@/editor/import/importReport';
import { ImportReportView, LazyImportPreview, reportHeadline, type ImportPreviewProps, type ImportPreviewSettled } from '@/editor/ui/importReport';
import { Button, Icon, Spinner, Tabs, TextArea, TextField } from '@/ui';
import type { ImportConversion } from './convert';
import { conversionProblem, createProblem, type ImportProblem, upstreamErrorProblem } from './importErrors';
import { createBrewRequest } from './importBrew';
import { clearImportSession, EMPTY_SESSION, type ImportSession, type ImportTab, type LoadedSource, readImportSession, writeImportSession } from './importSession';
import styles from './ImportPage.module.css';
import { formatBytes, IMPORT_FILE_ACCEPT, MAX_IMPORT_BYTES, readImportFile, sizeProblem, utf8Bytes } from './readTextFile';
import { prefetchEditor } from './prefetchEditor';
import { parseUpstreamLink, upstreamShareUrl } from './upstreamLink';

export type ConvertFn = (text: string) => Promise<ImportConversion>;

export interface ImportPageProps {
  /** The conversion (default: convert.ts's convertBrewText, loaded on demand). Tests pass a stub. */
  convert?: ConvertFn;
  /** The preview (default: LazyImportPreview). Tests pass a stub. */
  Preview?: ComponentType<ImportPreviewProps>;
  /** Loads the editor while the visitor reads the report (default: prefetchEditor). Tests pass a stub. */
  prefetch?: () => void;
}

const defaultConvert: ConvertFn = async (text) => (await import('./convert')).convertBrewText(text);

type Conversion =
  | { state: 'idle' }
  | { state: 'converting'; id: number; source: LoadedSource }
  | { state: 'done'; id: number; source: LoadedSource; conversion: ImportConversion }
  | { state: 'error'; id: number; source: LoadedSource; problem: ImportProblem };

/** The preview's layout of conversion `id`: the report with page counts and the paginated doc. */
interface Layout {
  id: number;
  report: ImportReportData;
  json: () => JSONContent;
}

const SESSION_WRITE_DELAY_MS = 300;

/** A problem shown next to what caused it (role=alert: announced when it appears). */
function Problem({ problem, testId, children }: { problem: ImportProblem; testId: string; children?: ReactNode }) {
  return (
    <div className={styles.problem} role="alert" data-testid={testId}>
      <Icon name="error" size={18} className={styles.problemIcon} />
      <div>
        <p className={styles.problemTitle}>{problem.title}</p>
        <p className={styles.problemText}>{problem.message}</p>
        {children}
      </div>
    </div>
  );
}

function sourceDescription(source: LoadedSource): string {
  const size = formatBytes(utf8Bytes(source.text));
  if (source.kind === 'paste') return `pasted text (${size})`;
  if (source.kind === 'file') return `the file ${source.label} (${size})`;
  return `the Homebrewery brew ${source.label} (${size})`;
}

export function ImportPage({ convert = defaultConvert, Preview = LazyImportPreview, prefetch = prefetchEditor }: ImportPageProps) {
  const navigate = useNavigate();
  const me = useMe({ meta: { errorPolicy: 'manual' } });
  const signedIn = me.data != null;
  const anonymous = me.isSuccess && me.data === null;

  const [session, setSession] = useState<ImportSession>(() => readImportSession() ?? EMPTY_SESSION);
  // A text converted before the visitor left for the sign-in page (or reloaded) is converted again:
  // the page starts in that conversion (id 1), and the effect below runs it.
  const [conversion, setConversion] = useState<Conversion>(() =>
    session.loaded ? { state: 'converting', id: 1, source: session.loaded } : { state: 'idle' },
  );
  const [layout, setLayout] = useState<Layout | null>(null);
  const [previewFailed, setPreviewFailed] = useState<number | null>(null);
  const [pasteProblem, setPasteProblem] = useState<ImportProblem | null>(null);
  const [fileProblem, setFileProblem] = useState<ImportProblem | null>(null);
  const [linkProblem, setLinkProblem] = useState<ImportProblem | null>(null);
  const [createError, setCreateError] = useState<ImportProblem | null>(null);
  // An action a sign-in interrupted: it runs once someone is signed in on this page.
  const pending = useRef<'create' | 'download' | null>(null);
  const runId = useRef(session.loaded ? 1 : 0);
  const focusCheck = useRef(false);
  const checkHeading = useRef<HTMLHeadingElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const checkId = useId();
  const createId = useId();

  // ─── Session (per tab): kept across the sign-in and register pages ─────────────────────────────
  const sessionRef = useRef(session);
  // Set once the brew is created (the session is cleared then): nothing writes the session again, not even a
  // delayed write still pending while the editor route loads.
  const created = useRef(false);
  useEffect(() => {
    sessionRef.current = session;
    const timer = window.setTimeout(() => {
      if (!created.current) writeImportSession(session);
    }, SESSION_WRITE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [session]);
  useEffect(() => {
    const flush = () => {
      if (!created.current) writeImportSession(sessionRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  // ─── Conversion ────────────────────────────────────────────────────────────────────────────────
  /** Converts `source` as conversion `id` (a newer conversion makes the result moot). */
  const runConversion = useCallback(
    (id: number, source: LoadedSource) => {
      convert(source.text).then(
        (result) => {
          if (runId.current === id) setConversion({ state: 'done', id, source, conversion: result });
        },
        (error: unknown) => {
          if (runId.current === id) setConversion({ state: 'error', id, source, problem: conversionProblem(error) });
        },
      );
    },
    [convert],
  );

  const load = useCallback(
    (source: LoadedSource, focusResult: boolean) => {
      const id = ++runId.current;
      focusCheck.current = focusResult;
      // A create the sign-in interrupted was for the previous brew.
      pending.current = null;
      setSession((s) => ({ ...s, loaded: source }));
      setConversion({ state: 'converting', id, source });
      setLayout(null);
      setPreviewFailed(null);
      setCreateError(null);
      runConversion(id, source);
    },
    [runConversion],
  );

  // The restored conversion (see the initial state), once: StrictMode runs effects twice.
  const restored = useRef(false);
  const runRestored = useEffectEvent(() => {
    if (conversion.state === 'converting' && conversion.id === 1 && runId.current === 1) runConversion(1, conversion.source);
  });
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    runRestored();
  }, []);

  // The result's heading takes the focus when the visitor started the conversion.
  useEffect(() => {
    if ((conversion.state === 'done' || conversion.state === 'error') && focusCheck.current) {
      focusCheck.current = false;
      checkHeading.current?.focus();
    }
  }, [conversion.state]);

  const onSettled = useCallback(
    (id: number, report: ImportReportData) =>
      ({ doc, json }: ImportPreviewSettled) => {
        if (runId.current !== id) return;
        setLayout({ id, report: recordPaginatedPages(report, doc), json });
      },
    [],
  );

  // ─── Sources ───────────────────────────────────────────────────────────────────────────────────
  const previewPaste = () => {
    const text = session.paste;
    if (!text.trim()) {
      setPasteProblem({ title: 'Nothing to import', message: 'Paste the brew’s text first.' });
      pasteRef.current?.focus();
      return;
    }
    const tooBig = sizeProblem(utf8Bytes(text));
    if (tooBig) {
      setPasteProblem({ title: 'Too large', message: tooBig });
      return;
    }
    setPasteProblem(null);
    load({ kind: 'paste', text, label: 'Pasted text' }, true);
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileProblem(null);
    const read = await readImportFile(file);
    if (!read.ok) {
      setFileProblem({ title: 'Can’t use this file', message: read.message });
      return;
    }
    load({ kind: 'file', text: read.text, label: file.name, ...(read.note ? { note: read.note } : {}) }, true);
  };

  // A 401 on this page's own requests (errorPolicy 'manual': the query client's policy leaves them
  // alone): the session is gone, so `me` becomes null, and the next sign-in resumes `action`.
  const queryClient = useQueryClient();
  const sessionEnded = (action: 'create' | 'download', error: ApiError) => {
    queryClient.setQueryData(queryKeys.account.me(), null);
    pending.current = action;
    requestSignIn(error);
  };

  const download = useUpstreamImport({ meta: { errorPolicy: 'manual' } });
  const downloadNow = () => {
    const parsed = parseUpstreamLink(session.link);
    if (!parsed.ok) {
      setLinkProblem({ title: 'Can’t download this', message: parsed.message });
      return;
    }
    setLinkProblem(null);
    if (anonymous) {
      pending.current = 'download';
      requestSignIn(null);
      return;
    }
    download.mutate(parsed.shareId, {
      onSuccess: (text) => {
        if (!text.trim()) {
          setLinkProblem({ title: 'Nothing to import', message: 'The Homebrewery sent an empty brew.' });
          return;
        }
        load({ kind: 'link', text, label: parsed.shareId }, true);
      },
      onError: (error) => {
        if (isApiError(error) && error.status === 401) {
          sessionEnded('download', error);
          return;
        }
        setLinkProblem(upstreamErrorProblem(error));
      },
    });
  };

  // ─── Create ────────────────────────────────────────────────────────────────────────────────────
  const create = useCreateBrew({ meta: { errorPolicy: 'manual' } });
  const createNow = () => {
    if (conversion.state !== 'done' || create.isPending) return;
    if (anonymous) {
      pending.current = 'create';
      requestSignIn(null);
      return;
    }
    const { conversion: result, source, id } = conversion;
    const doc = layout?.id === id ? layout.json() : result.result.doc;
    const body = createBrewRequest({ meta: result.meta, style: result.result.style, snippets: result.snippets }, doc, source.text);
    setCreateError(null);
    create.mutate(body, {
      onSuccess: (brew) => {
        created.current = true;
        clearImportSession();
        void navigate(paths.edit(brew.editId));
      },
      onError: (error) => {
        if (isApiError(error) && error.status === 401) {
          sessionEnded('create', error);
          return;
        }
        setCreateError(createProblem(error));
      },
    });
  };

  // Signed in (the dialog, or an expired session renewed): finish what the sign-in interrupted.
  const resume = useEffectEvent(() => {
    const action = pending.current;
    pending.current = null;
    if (action === 'create') createNow();
    else if (action === 'download') downloadNow();
  });
  useEffect(() => {
    if (signedIn && pending.current) resume();
  }, [signedIn]);

  // The preview has laid the brew out: the next step is probably "Create brew", which opens the editor.
  useEffect(() => {
    if (layout) prefetch();
  }, [layout, prefetch]);

  const startOver = () => {
    runId.current++;
    pending.current = null;
    clearImportSession();
    setSession(EMPTY_SESSION);
    setConversion({ state: 'idle' });
    setLayout(null);
    setPasteProblem(null);
    setFileProblem(null);
    setLinkProblem(null);
    setCreateError(null);
    requestAnimationFrame(() => pasteRef.current?.focus());
  };

  const setTab = (tab: string) => setSession((s) => ({ ...s, tab: tab as ImportTab }));

  // ─── Render ────────────────────────────────────────────────────────────────────────────────────
  const busy = conversion.state === 'converting' || download.isPending;
  const done = conversion.state === 'done' ? conversion : null;
  const currentLayout = done && layout?.id === done.id ? layout : null;
  const report = currentLayout?.report ?? done?.conversion.result.report ?? null;
  const layoutState = currentLayout ? 'done' : done && previewFailed === done.id ? 'unavailable' : 'pending';
  const notes = done ? [...(done.source.note ? [done.source.note] : []), ...done.conversion.notes] : [];

  const pastePanel = (
    <div className={styles.panel}>
      <TextArea
        ref={pasteRef}
        label="Brew text"
        hint={`The brew’s markdown, as the Homebrewery shows it in its editor. A downloaded brew’s metadata and CSS blocks are read too. Up to ${formatBytes(MAX_IMPORT_BYTES)}.`}
        rows={12}
        spellCheck={false}
        inputClassName={styles.code}
        value={session.paste}
        onChange={(e) => {
          const value = e.target.value;
          setSession((s) => ({ ...s, paste: value }));
          if (pasteProblem) setPasteProblem(null);
        }}
        data-testid="import-paste"
      />
      {pasteProblem ? <Problem problem={pasteProblem} testId="import-paste-error" /> : null}
      <div className={styles.actions}>
        <Button variant="primary" onClick={previewPaste} loading={busy && conversion.state === 'converting' && conversion.source.kind === 'paste'} data-testid="import-paste-preview">
          Preview the import
        </Button>
      </div>
    </div>
  );

  const fileHintId = useId();
  const fileInputId = useId();
  const filePanel = (
    <div className={styles.panel}>
      <div className={styles.field}>
        <label htmlFor={fileInputId} className={styles.fieldLabel}>
          Brew file
        </label>
        <p id={fileHintId} className={styles.fieldHint}>
          A .txt or .md file of up to {formatBytes(MAX_IMPORT_BYTES)}. On the Homebrewery, open the brew and choose Source → Download to get it. The preview
          starts as soon as you choose the file.
        </p>
        <input
          id={fileInputId}
          type="file"
          accept={IMPORT_FILE_ACCEPT}
          className={styles.fileInput}
          aria-describedby={fileHintId}
          onChange={(e) => {
            void onFile(e);
            // The same file can be chosen again (after a fix, or to start over).
            e.target.value = '';
          }}
          data-testid="import-file"
        />
      </div>
      {fileProblem ? <Problem problem={fileProblem} testId="import-file-error" /> : null}
    </div>
  );

  const linkPanel = (
    <div className={styles.panel}>
      <form
        className={styles.linkForm}
        onSubmit={(e) => {
          e.preventDefault();
          downloadNow();
        }}
      >
        <TextField
          label="Share link or share id"
          hint="The link from the brew’s Share menu on the Homebrewery, like https://homebrewery.naturalcrit.com/share/…, or just its id."
          placeholder="https://homebrewery.naturalcrit.com/share/…"
          value={session.link}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            const value = e.target.value;
            setSession((s) => ({ ...s, link: value }));
            if (linkProblem) setLinkProblem(null);
          }}
          data-testid="import-link"
        />
        {anonymous ? (
          <p className={styles.note} data-testid="import-link-sign-in-note">
            <Icon name="user" size={16} className={styles.noteIcon} />
            Downloading from the Homebrewery needs an account: you’ll be asked to sign in.
          </p>
        ) : null}
        {linkProblem ? <Problem problem={linkProblem} testId="import-link-error" /> : null}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" loading={download.isPending} data-testid="import-link-download">
            {anonymous ? 'Sign in and download' : 'Download and preview'}
          </Button>
        </div>
      </form>
    </div>
  );

  return (
    <SitePage
      title="Import a brew"
      width="wide"
      lead="Bring a brew over from the Homebrewery. You’ll see what the import changed, and a preview, before anything is saved."
      data-testid="import-page"
    >
      <section className={styles.step} aria-labelledby={`${checkId}-source`}>
        <h2 id={`${checkId}-source`} className={styles.stepTitle}>
          1. Choose the brew
        </h2>
        <Tabs
          label="Where the brew comes from"
          value={session.tab}
          onValueChange={setTab}
          className={styles.tabs}
          items={[
            { id: 'paste', label: 'Paste text', content: pastePanel },
            { id: 'file', label: 'Upload a file', content: filePanel },
            { id: 'link', label: 'Homebrewery link', content: linkPanel },
          ]}
          data-testid="import-source-tabs"
        />
      </section>

      {/* Announcements for the conversion (the result's heading also takes the focus). */}
      <p className={styles.srOnly} role="status" data-testid="import-status">
        {conversion.state === 'converting'
          ? 'Converting the brew…'
          : conversion.state === 'done'
            ? `Converted. ${reportHeadline(report ?? conversion.conversion.result.report, notes)}`
            : ''}
      </p>

      {conversion.state !== 'idle' ? (
        <section className={styles.step} aria-labelledby={checkId} data-testid="import-check" data-state={conversion.state}>
          <div className={styles.stepHeader}>
            <h2 id={checkId} ref={checkHeading} tabIndex={-1} className={styles.stepTitle}>
              2. Check the import
            </h2>
            <Button variant="ghost" size="sm" icon="close" onClick={startOver} data-testid="import-start-over">
              Start over
            </Button>
          </div>
          <p className={styles.sourceLine} data-testid="import-source">
            From {sourceDescription(conversion.source)}
            {conversion.source.kind === 'link' ? (
              <>
                {' · '}
                <a className={styles.link} href={upstreamShareUrl(conversion.source.label)} target="_blank" rel="noreferrer noopener">
                  open it on the Homebrewery<span className={styles.srOnly}> (opens in a new tab)</span>
                </a>
              </>
            ) : null}
          </p>

          {conversion.state === 'converting' ? (
            <div className={styles.converting} data-testid="import-converting">
              <Spinner size={20} decorative />
              <span>Converting the brew and laying out its pages with the theme…</span>
            </div>
          ) : null}

          {conversion.state === 'error' ? <Problem problem={conversion.problem} testId="import-convert-error" /> : null}

          {done && report ? (
            <div className={styles.checkGrid}>
              <div className={styles.reportColumn}>
                <ImportReportView report={report} layout={layoutState} notes={notes} headingLevel={3} />
              </div>
              <div className={styles.previewColumn}>
                <h3 className={styles.previewTitle}>Preview</h3>
                <div className={styles.previewBox}>
                  <Preview
                    key={done.id}
                    doc={done.conversion.result.doc}
                    theme={done.conversion.theme}
                    style={done.conversion.result.style}
                    lang={done.conversion.meta.lang ?? 'en'}
                    onSettled={onSettled(done.id, done.conversion.result.report)}
                    onStatusChange={(status) => {
                      if (status.state === 'error') setPreviewFailed(done.id);
                    }}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {done ? (
        <section className={styles.createBar} aria-labelledby={createId} data-testid="import-create">
          <h2 id={createId} className={styles.srOnly}>
            3. Create the brew
          </h2>
          <dl className={styles.facts}>
            <div>
              <dt>Title</dt>
              <dd data-testid="import-meta-title">{done.conversion.meta.title || 'None yet (the first heading becomes the title)'}</dd>
            </div>
            <div>
              <dt>Theme</dt>
              <dd data-testid="import-meta-theme">{done.conversion.themeName}</dd>
            </div>
            <div>
              <dt>Pages</dt>
              <dd data-testid="import-meta-pages">{report?.paginated?.pages ?? done.conversion.result.report.pages}</dd>
            </div>
            {done.conversion.meta.tags?.length ? (
              <div>
                <dt>Tags</dt>
                <dd data-testid="import-meta-tags">{done.conversion.meta.tags.join(', ')}</dd>
              </div>
            ) : null}
            {done.conversion.snippets?.length ? (
              <div>
                <dt>Snippets</dt>
                <dd data-testid="import-meta-snippets">{done.conversion.snippets.length}</dd>
              </div>
            ) : null}
          </dl>
          {createError ? <Problem problem={createError} testId="import-create-error" /> : null}
          {anonymous ? (
            <p className={styles.note} data-testid="import-sign-in-note">
              <Icon name="user" size={16} className={styles.noteIcon} />
              <span>
                Sign in to save the brew to your account; this page keeps your import while you do.{' '}
                <Link className={styles.link} to={paths.register(paths.import)}>
                  Create an account
                </Link>
              </span>
            </p>
          ) : null}
          <div className={styles.createActions}>
            <Button variant="primary" icon={anonymous ? 'user' : 'check'} loading={create.isPending} onClick={createNow} data-testid="import-create-button">
              {anonymous ? 'Sign in and create the brew' : 'Create brew'}
            </Button>
          </div>
        </section>
      ) : null}
    </SitePage>
  );
}
