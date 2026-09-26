import type { Editor } from '@tiptap/core';
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { scopeCssText } from '@/editor/canvas/cssScope';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import { transformPastedHtml } from '@/editor/canvas/pasteCleanup';
import type { CanvasStatus, RepaginateEvent } from '@/editor/canvas/useCanvasTheme';
import type { CanvasSpread } from '@/editor/canvas/useCanvasZoom';
import styles from './CanvasDevPage.module.css';
import { devDocs, s1Page1Markdown } from './devDocs';
import { LegacyView } from './LegacyView';

const THEMES = ['5ePHB', '5eDMG', 'Blank', 'Journal', 'UnearthedArcana'];
const ZOOMS = [0.5, 0.75, 1, 1.5, 2];
const SPREADS: CanvasSpread[] = ['single', 'facing', 'flow'];

/** What the page exposes to Playwright (dev only). */
export interface CanvasDevGlobals {
  editor: Editor;
  handle: EditorCanvasHandle;
  repaginations: RepaginateEvent[];
  statuses: CanvasStatus[];
  scopeCssText: typeof scopeCssText;
  transformPastedHtml: typeof transformPastedHtml;
}

declare global {
  interface Window {
    __editor?: Editor;
    __hbCanvas?: CanvasDevGlobals;
  }
}

/**
 * /dev/canvas[?theme=5ePHB&zoom=1&spread=single&doc=s1|chrome|blank&css=…]: EditorCanvas (PageView,
 * theme chain, user CSS, fonts gate, zoom, spreads) on a hand-built document. The frame's
 * data-theme-status turns "ready" when theme, CSS and fonts are applied. window.__editor and
 * window.__hbCanvas are for the e2e specs (web/e2e/canvas).
 *
 * ?view=legacy shows page 1 of the s1 document rendered by the old renderer instead (marked-hbfm
 * in an iframe, LegacyView), for the S1 screenshot comparison.
 */
export function CanvasDevPage() {
  const [params, setParams] = useSearchParams();
  const theme = params.get('theme') ?? '5ePHB';
  const zoom = Number(params.get('zoom') ?? '1') || 1;
  const spreadParam = params.get('spread') as CanvasSpread | null;
  const spread: CanvasSpread = spreadParam && SPREADS.includes(spreadParam) ? spreadParam : 'single';
  const docKey = params.get('doc') ?? 's1';
  const content = devDocs[docKey] ?? devDocs.s1!;
  const [userCss, setUserCss] = useState(params.get('css') ?? '');
  const [status, setStatus] = useState<CanvasStatus>({
    state: 'loading',
    theme,
  });
  const [repaginations, setRepaginations] = useState(0);
  const legacy = params.get('view') === 'legacy';
  const [legacyReady, setLegacyReady] = useState(false);
  const onLegacyStatus = useCallback(
    (state: 'loading' | 'ready' | 'error', message?: string) => {
      if (state === 'error') setStatus({ state: 'error', theme, message: message ?? '' });
      setLegacyReady(state === 'ready');
    },
    [theme],
  );

  const set = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const onReady = useCallback((editor: Editor, handle: EditorCanvasHandle) => {
    window.__editor = editor;
    window.__hbCanvas = {
      editor,
      handle,
      repaginations: [],
      statuses: [],
      scopeCssText,
      transformPastedHtml,
    };
  }, []);
  const onStatusChange = useCallback((next: CanvasStatus) => {
    window.__hbCanvas?.statuses.push(next);
    setStatus(next);
  }, []);
  const onRepaginate = useCallback((event: RepaginateEvent) => {
    window.__hbCanvas?.repaginations.push(event);
    setRepaginations((n) => n + 1);
  }, []);

  return (
    <div className={styles.frame} data-theme-status={legacy ? (legacyReady ? 'ready' : status.state) : status.state}>
      <header className={styles.bar}>
        <strong>/dev/canvas</strong>
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
        <label>
          doc{' '}
          <select data-testid="doc-select" value={docKey} onChange={(e) => set('doc', e.target.value)}>
            {Object.keys(devDocs).map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <span data-testid="canvas-status">
          {status.state === 'ready'
            ? `${status.chain.source}: ${status.chain.snippets.map((s) => (typeof s === 'string' ? s : s.name)).join(' → ')}${status.fontsLoaded ? '' : ' (fonts timed out)'}${status.failed.length ? `, failed: ${status.failed.join(', ')}` : ''}`
            : status.state === 'error'
              ? status.message
              : 'loading…'}
        </span>
        <span data-testid="repaginate-count">repaginations: {repaginations}</span>
        <p className={styles.probe} data-testid="leak-probe">
          app text
        </p>
      </header>
      <div className={styles.body}>
        <textarea
          className={styles.css}
          data-testid="css-input"
          spellCheck={false}
          placeholder="Brew CSS, e.g. .page { background: lavender }"
          value={userCss}
          onChange={(e) => setUserCss(e.target.value)}
        />
        {legacy ? (
          <LegacyView markdown={s1Page1Markdown()} theme={theme} onStatus={onLegacyStatus} />
        ) : (
          <EditorCanvas
            key={docKey}
            className={styles.canvas}
            content={content}
            theme={theme}
            userCss={userCss}
            zoom={zoom}
            spread={spread}
            lang="en"
            onReady={onReady}
            onStatusChange={onStatusChange}
            onRepaginate={onRepaginate}
          />
        )}
      </div>
    </div>
  );
}
