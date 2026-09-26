import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type BrewForEdit, useBrewForEdit, useSaveBrew } from '@/api';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import type { CanvasSpread } from '@/editor/canvas/useCanvasZoom';
import { Pagination } from '@/editor/pagination';
import { MetadataDialog } from '@/editor/ui/metadata/MetadataDialog';
import { OutlinePanel } from '@/editor/ui/outline/OutlinePanel';
import { PageNav } from '@/editor/ui/pageNav/PageNav';
import type { PageTracker } from '@/editor/ui/pageNav/pageTracker';
import { usePageTracker } from '@/editor/ui/pageNav/usePageTracker';
import { useUiStore } from '@/app/uiStore';
import { draftFromBrew, type MetadataBrew, type MetadataChange, metadataBrewFrom } from '@/ported/metadata/metaDraft';
import { Button, SplitMain, SplitPanel, Toolbar, UiRoot } from '@/ui';
import { longDoc, panelsDoc } from './panelDocs';
import styles from './PanelsDevPage.module.css';

/** What the page exposes to Playwright (dev only). */
export interface PanelsDevGlobals {
  editor: Editor;
  handle: EditorCanvasHandle;
  tracker: PageTracker | null;
  changes: MetadataChange[];
}

declare global {
  interface Window {
    __hbPanels?: PanelsDevGlobals;
  }
}

const THEMES = ['5ePHB', '5eDMG', 'Blank', 'Journal'];
const ZOOMS = [0.5, 0.75, 1, 1.5, 2];
const SPREADS: CanvasSpread[] = ['single', 'facing', 'flow'];
const ROLES = ['owner', 'author', 'invited'] as const;

/** The fixture brew of the metadata dialog (no API) for ?role= and ?lock=1. */
function fixtureBrew(role: (typeof ROLES)[number], locked: boolean, reviewRequested: boolean): MetadataBrew {
  return {
    editId: 'devEditId001',
    shareId: 'devShareId01',
    meta: {
      title: 'The Wandering Inn',
      description: 'An inn that is never in the same place twice.',
      tags: ['meta:Template', 'system:D&D 5e'],
      lang: 'en',
      theme: '5ePHB',
      published: false,
      thumbnailUrl: null,
    },
    authors: [
      { handle: 'alice', role: 'owner' },
      { handle: 'bob', role: 'author' },
      { handle: 'carol', role: 'invited' },
    ],
    role,
    lock: locked
      ? { code: 455, message: 'This brew copies copyrighted text.', applied: '2026-09-01T12:00:00Z', reviewRequested: reviewRequested ? '2026-09-02T08:30:00Z' : null }
      : null,
  };
}

/**
 * /dev/panels: the outline panel, the page navigation toolbar and the metadata dialog around an
 * EditorCanvas (P3.7, P3.9). Query parameters: theme, zoom, spread, doc=panels|long,
 * paginate=1 (pagination on; off by default so the page count is fixed), role=owner|author|invited
 * and lock=1|review (the fixture brew of the dialog), edit=<editId> (use a real brew from the API
 * instead; the Save button then sends the dialog's meta with PUT /api/brews/{editId}).
 * window.__hbPanels is for the e2e specs (web/e2e/panels).
 */
export function PanelsDevPage() {
  const [params, setParams] = useSearchParams();
  const theme = params.get('theme') ?? '5ePHB';
  const zoom = Number(params.get('zoom') ?? '1') || 1;
  const spreadParam = params.get('spread') as CanvasSpread | null;
  const spread: CanvasSpread = spreadParam && SPREADS.includes(spreadParam) ? spreadParam : 'single';
  const docKey = params.get('doc') === 'long' ? 'long' : 'panels';
  const paginate = params.get('paginate') === '1';
  const roleParam = params.get('role');
  const role = ROLES.find((r) => r === roleParam) ?? 'owner';
  const lockParam = params.get('lock');
  const editId = params.get('edit') ?? undefined;

  const content = useMemo(() => (docKey === 'long' ? longDoc() : panelsDoc), [docKey]);
  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo(() => (paginate ? [Pagination.configure({ isReady: gate.isReady })] : []), [paginate, gate]);

  const [status, setStatus] = useState<CanvasStatus>({ state: 'loading', theme });
  const [handle, setHandle] = useState<EditorCanvasHandle | null>(null);
  const tracker = usePageTracker(handle);
  const changes = useRef<MetadataChange[]>([]);
  const [lastChange, setLastChange] = useState<MetadataChange | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleted, setDeleted] = useState<string | null>(null);
  const propertiesRef = useRef<HTMLButtonElement>(null);
  const outlineToggleRef = useRef<HTMLButtonElement>(null);
  const outlineOpen = useUiStore((s) => s.panels.outline.open);
  const togglePanel = useUiStore((s) => s.togglePanel);

  const live = useBrewForEdit(editId, { meta: { errorPolicy: 'manual' } });
  const brew: MetadataBrew | null = editId
    ? live.data
      ? metadataBrewFrom(live.data)
      : null
    : fixtureBrew(role, lockParam === '1' || lockParam === 'review', lockParam === 'review');
  const save = useSaveBrew(editId ?? '', { meta: { errorPolicy: 'manual' } });

  const set = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const onReady = useCallback((editor: Editor, next: EditorCanvasHandle) => {
    // TipTap gives its root role=textbox without a name; EditorCanvas doesn't name it yet
    // (canvas/shell lane). ProseMirror leaves attributes it doesn't manage alone.
    editor.view.dom.setAttribute('aria-label', 'Brew pages');
    window.__hbPanels = { editor, handle: next, tracker: null, changes: changes.current };
    setHandle(next);
  }, []);
  useEffect(() => {
    if (window.__hbPanels) window.__hbPanels.tracker = tracker;
  }, [tracker, handle]);

  const onMetaChange = (change: MetadataChange) => {
    changes.current.push(change);
    setLastChange(change);
    setChangeCount((n) => n + 1);
  };

  const saveMeta = (loaded: BrewForEdit) => {
    save.mutate({
      body: {
        baseVersion: loaded.version,
        doc: loaded.doc,
        style: loaded.style,
        snippets: loaded.snippets,
        meta: lastChange?.meta ?? {},
      },
    });
  };

  return (
    <UiRoot surface={false} className={styles.frame} data-theme-status={status.state}>
      <header className={styles.bar}>
        <h1 className={styles.title}>Panels</h1>
        <Button
          ref={outlineToggleRef}
          size="sm"
          icon="outline"
          pressed={outlineOpen}
          aria-controls="hb-outline-panel"
          onClick={() => togglePanel('outline')}
          data-testid="toggle-outline"
        >
          Outline
        </Button>
        <label>
          theme{' '}
          <select data-testid="theme-select" value={theme} onChange={(e) => set('theme', e.target.value)}>
            {THEMES.map((th) => (
              <option key={th}>{th}</option>
            ))}
          </select>
        </label>
        <label>
          zoom{' '}
          <select data-testid="zoom-select" value={String(zoom)} onChange={(e) => set('zoom', e.target.value)}>
            {ZOOMS.map((z) => (
              <option key={z} value={String(z)}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
        </label>
        <label>
          spread{' '}
          <select data-testid="spread-select" value={spread} onChange={(e) => set('spread', e.target.value)}>
            {SPREADS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        {editId ? null : (
          <label>
            role{' '}
            <select data-testid="role-select" value={role} onChange={(e) => set('role', e.target.value)}>
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        )}
        <Button
          ref={propertiesRef}
          size="sm"
          icon="settings"
          variant="primary"
          disabled={!brew}
          onClick={() => setDialogOpen(true)}
          data-testid="open-properties"
        >
          Properties
        </Button>
        {editId && live.data ? (
          <Button size="sm" loading={save.isPending} onClick={() => saveMeta(live.data)} data-testid="save-meta">
            Save
          </Button>
        ) : null}
        <span className={styles.status} data-testid="save-status">
          {editId ? (live.isError ? 'load failed' : save.isSuccess ? `saved v${save.data.version}` : save.isError ? 'save failed' : live.data ? `v${live.data.version}` : 'loading') : ''}
        </span>
      </header>

      <SplitPanel className={styles.body}>
        <OutlinePanel editor={handle?.editor} tracker={tracker} returnFocusRef={outlineToggleRef} />
        <SplitMain className={styles.main}>
          <Toolbar label="Page navigation" className={styles.toolbar}>
            <PageNav tracker={tracker} />
          </Toolbar>
          <EditorCanvas
            key={docKey}
            className={styles.canvas}
            content={content}
            theme={theme}
            zoom={zoom}
            spread={spread}
            gate={gate}
            extensions={extensions}
            onReady={onReady}
            onStatusChange={setStatus}
          />
        </SplitMain>
        <aside className={styles.log} aria-label="Metadata changes">
          <h2 className={styles.logTitle}>Last metadata change</h2>
          <p>
            field: <output data-testid="meta-field">{lastChange?.field ?? '—'}</output> · changes:{' '}
            <output data-testid="meta-count">{changeCount}</output>
          </p>
          <pre className={styles.payload} data-testid="meta-payload">
            {lastChange ? JSON.stringify(lastChange.meta, null, 2) : '(none)'}
          </pre>
          {deleted ? <p data-testid="deleted">{deleted}</p> : null}
        </aside>
      </SplitPanel>

      {brew ? (
        <MetadataDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          brew={brew}
          draft={lastChange?.draft ?? draftFromBrew(brew)}
          onChange={onMetaChange}
          serverError={save.error}
          onDeleted={(result, id) => setDeleted(`${id}: ${result.brewDeleted ? 'deleted' : 'left'}`)}
        />
      ) : null}
    </UiRoot>
  );
}
