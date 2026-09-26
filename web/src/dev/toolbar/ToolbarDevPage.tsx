import type { Editor } from '@tiptap/core';
import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useUiStore } from '@/app/uiStore';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import type { CanvasStatus } from '@/editor/canvas/useCanvasTheme';
import { hbKeymapExtensions, onKeymapRequest, runChain } from '@/editor/commands/keymap';
import { Sections } from '@/editor/commands/sections';
import { Pagination } from '@/editor/pagination';
import { EditorToolbar } from '@/editor/ui/toolbar';
import { type MenuEntry, MenuButton, UiRoot } from '@/ui';
import { devDocs } from './devDocs';
import { createHarness, type ToolbarHarnessApi } from './harness';
import styles from './ToolbarDevPage.module.css';

const THEMES = ['5ePHB', '5eDMG', 'Blank', 'Journal', 'UnearthedArcana'];

/**
 * /dev/toolbar[?theme=5ePHB&doc=basic|long&print=1]: EditorCanvas with pagination, HbKeymap and
 * the EditorToolbar (P3.4). Mod-S and Mod-P are logged (print=1 really prints). The frame's
 * data-theme-status turns "ready" with the canvas; window.__hbToolbar is the test API (harness.ts,
 * web/e2e/toolbar).
 */
export function ToolbarDevPage() {
  const [params, setParams] = useSearchParams();
  const theme = params.get('theme') ?? '5ePHB';
  const docKey = params.get('doc') ?? 'basic';
  const realPrint = params.get('print') === '1';
  const content = useMemo(() => (devDocs[docKey] ?? devDocs.basic!)(), [docKey]);
  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo(() => [...hbKeymapExtensions, Pagination.configure({ isReady: gate.isReady }), Sections], [gate]);
  const zoom = useUiStore((s) => s.zoom);
  const spread = useUiStore((s) => s.spread);
  const startOnRight = useUiStore((s) => s.startOnRight);
  const pageShadows = useUiStore((s) => s.pageShadows);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [handle, setHandle] = useState<EditorCanvasHandle | null>(null);
  const [status, setStatus] = useState<CanvasStatus['state']>('loading');
  const [saves, setSaves] = useState(0);
  const [prints, setPrints] = useState(0);
  const harness = useRef<ToolbarHarnessApi | null>(null);

  const onReady = useCallback((e: Editor, h: EditorCanvasHandle) => {
    const api = createHarness(e, h);
    harness.current = api;
    window.__hbToolbar = api;
    setEditor(e);
    setHandle(h);
  }, []);
  const onStatusChange = useCallback((next: CanvasStatus) => setStatus(next.state), []);
  const onToolbarRender = useCallback(() => {
    if (harness.current) harness.current.toolbarRenders += 1;
  }, []);

  // Mod-S and Mod-P: what the app wires to autosave's saveNow and the canvas print.
  useEffect(() => {
    if (!editor) return;
    return onKeymapRequest(editor, (request) => {
      if (request === 'save') {
        harness.current?.requests.push('save');
        setSaves((n) => n + 1);
        return true;
      }
      if (request === 'print') {
        harness.current?.requests.push('print');
        setPrints((n) => n + 1);
        if (realPrint) void handle?.print();
        return true;
      }
      return false;
    });
  }, [editor, handle, realPrint]);

  return (
    <div className={styles.frame} data-theme-status={status}>
      <UiRoot className={styles.chrome}>
        <header className={styles.bar}>
          <h1 className={styles.title}>Toolbar and keymap</h1>
          <label className={styles.control}>
            Theme{' '}
            <select
              value={theme}
              data-testid="theme-select"
              onChange={(event) =>
                setParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.set('theme', event.target.value);
                    return next;
                  },
                  { replace: true },
                )
              }
            >
              {THEMES.map((th) => (
                <option key={th}>{th}</option>
              ))}
            </select>
          </label>
          <output className={styles.requests} data-testid="requests">
            save {saves} · print {prints}
          </output>
        </header>
        {editor ? (
          <Profiler id="toolbar" onRender={onToolbarRender}>
            <EditorToolbar
              editor={editor}
              insertMenu={<DevInsertMenu editor={editor} />}
              status={
                <span role="status" data-testid="save-status">
                  {saves > 0 ? `Saved (${saves})` : 'Not saved yet'}
                </span>
              }
              data-testid="editor-toolbar"
            />
          </Profiler>
        ) : (
          <div className={styles.placeholder} />
        )}
      </UiRoot>
      <main className={styles.body}>
        <EditorCanvas
          key={docKey}
          className={styles.canvas}
          content={content}
          theme={theme}
          themeSource="static"
          extensions={extensions}
          gate={gate}
          zoom={zoom}
          spread={spread}
          startOnRight={startOnRight}
          pageShadows={pageShadows}
          onReady={onReady}
          onStatusChange={onStatusChange}
        />
      </main>
    </div>
  );
}

/** A stand-in for the snippets lane's InsertMenu in the toolbar's Insert slot. */
function DevInsertMenu({ editor }: { editor: Editor }) {
  const items: MenuEntry[] = [
    { id: 'rule', label: 'Horizontal rule', onSelect: () => runChain(editor, (c) => c.insertContent({ type: 'horizontalRule' })) },
    { id: 'spacer', label: 'Vertical space', onSelect: () => runChain(editor, (c) => c.insertContent({ type: 'spacer' })) },
  ];
  return <MenuButton label="Insert" icon="insert" iconOnly menuLabel="Insert" items={items} data-testid="dev-insert-menu" />;
}
