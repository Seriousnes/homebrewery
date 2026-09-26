import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router';
import { EditorCanvas } from '@/editor/canvas/EditorCanvas';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { LayoutStatus } from '@/editor/ui/layoutStatus/LayoutStatus';
import { UiRoot } from '@/ui';
import { FIXTURES } from './fixtures';
import { PaginationHarness } from './harness';
import styles from './PaginationDevPage.module.css';
import { SectionsToolbar } from './SectionsToolbar';

export interface PaginationDevPageProps {
  /** 'sections' adds a toolbar (page break, section columns, block type); default fixture differs */
  variant?: 'pagination' | 'sections';
}

/**
 * /dev/pagination[?theme=5ePHB|Blank|Journal&doc=<fixture>&zoom=1&paginate=1&css=…&busyDelay=ms] and
 * /dev/sections (the same page with a toolbar).
 *
 * EditorCanvas (PageView, theme chain, user CSS, zoom, fonts gate) with paginatedExtensions()
 * (pagination, section commands, seam editing, history-safe block types) and the layout status
 * (P4.8). `data-theme-status="ready"` is set once the canvas is ready (theme, CSS, fonts).
 * window.__hbPagination is the test API (harness.ts, web/e2e/pagination/harness.ts).
 */
export function PaginationDevPage({ variant = 'pagination' }: PaginationDevPageProps) {
  const [params] = useSearchParams();
  const fixture = params.get('doc') ?? (variant === 'sections' ? 'sections' : 'sample');
  const [theme, setTheme] = useState(params.get('theme') ?? '5ePHB');
  const [zoom, setZoom] = useState(Number(params.get('zoom') ?? '1') || 1);
  const [userCss, setUserCss] = useState(params.get('css') ?? '');
  const busyDelay = Number(params.get('busyDelay')) || undefined;
  const [harness] = useState(() => new PaginationHarness({ paginate: params.get('paginate') !== '0' }));
  const [content] = useState(() => (FIXTURES[fixture] ?? FIXTURES.sample!)());
  const [status, setStatus] = useState<CanvasStatus['state']>('loading');
  const [message, setMessage] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  useSyncExternalStore(harness.subscribe, harness.snapshot);

  useLayoutEffect(() => {
    harness.setControls({
      // Synchronous, so the harness API (and the zoom specs) see the new zoom right away.
      setZoom: (z) => flushSync(() => setZoom(z)),
      setUserCss: (css) => setUserCss(css),
      setTheme: (t) => setTheme(t),
    });
    return () => harness.setControls(null);
  }, [harness]);

  useEffect(() => () => harness.attach(null), [harness]);

  const onReady = useCallback(
    (ready: Editor) => {
      harness.attach(ready);
      setEditor(ready);
    },
    [harness],
  );

  const onStatusChange = useCallback((next: CanvasStatus) => {
    setStatus(next.state);
    if (next.state === 'ready') setMessage(`${next.chain.source} chain ${next.chain.snippets.map((s) => (typeof s === 'string' ? s : s.name)).join(' → ')}`);
    else if (next.state === 'error') setMessage(next.message);
  }, []);

  const st = harness.status();
  return (
    <div className={styles.frame} data-theme-status={status} data-settled={st.settled ? 'true' : 'false'}>
      <UiRoot colorScheme="dark" surface={false} className={styles.bar}>
        <header className={styles.header}>
          <strong>{variant === 'sections' ? '/dev/sections' : '/dev/pagination'}</strong> theme <code>{theme}</code> doc <code>{fixture}</code> zoom{' '}
          <code>{zoom}</code>: {status === 'loading' ? 'loading…' : message} · {st.pages} pages · {st.settled ? 'settled' : 'laying out…'}
          {st.stats
            ? ` · settles ${st.stats.settles}, steps ${st.stats.steps} (last ${st.stats.lastSettleSteps}, max ${st.stats.maxSettleSteps}), guard ${st.stats.guardHits}, errors ${st.stats.errors}`
            : ''}
          {harness.lastSettle ? ` · last settle ${harness.lastSettle.ms.toFixed(1)} ms` : ''}
        </header>
        <div className={styles.tools}>
          {variant === 'sections' && <SectionsToolbar editor={editor} />}
          <LayoutStatus editor={editor} delayMs={busyDelay} />
        </div>
      </UiRoot>
      <div className={styles.canvasArea}>
        <EditorCanvas
          content={content}
          theme={theme}
          userCss={userCss}
          zoom={zoom}
          gate={harness.gate}
          extensions={harness.extensions}
          onReady={onReady}
          onStatusChange={onStatusChange}
          onRepaginate={harness.onCanvasRepaginate}
        />
      </div>
    </div>
  );
}
