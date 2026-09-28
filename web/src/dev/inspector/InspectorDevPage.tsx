import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUiStore } from '@/app/uiStore';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas, type EditorCanvasHandle } from '@/editor/canvas/EditorCanvas';
import type { CanvasStatus, RepaginateEvent } from '@/editor/canvas/useCanvasTheme';
import { PageObjects } from '@/editor/objects/extension';
import { selectedObject, type ObjectRef } from '@/editor/objects/state';
import { isSettled, Pagination } from '@/editor/pagination';
import { InspectorPanel, OBJECT_SELECT_EVENT, type PageObjectRef } from '@/editor/ui/inspector';
import { StylePanel, type StyleEditorApi, type StyleEditorHandle } from '@/editor/ui/styleDrawer';
import { IconButton, type MenuEntry, MenuButton, Select, SplitMain, SplitPanel, type UiColorScheme, UiRoot } from '@/ui';
import { inspectorDoc } from './devDoc';
import styles from './InspectorDevPage.module.css';

const THEMES = ['5ePHB', '5eDMG', 'Blank', 'Journal'];

/** What the page exposes to Playwright (dev only; web/e2e/inspector). */
export interface InspectorDevGlobals {
  editor: Editor;
  handle: EditorCanvasHandle;
  style: () => StyleEditorHandle | null;
  repaginations: RepaginateEvent[];
  /** Page objects the inspector's list selected (OBJECT_SELECT_EVENT). */
  selectedObjects: PageObjectRef[];
  /** Pagination has nothing left to do. */
  settled: () => boolean;
  /** The objects lane's selected object. */
  selectedObject: () => ObjectRef | null;
  /**
   * The brew CSS of the last render that committed (set by an effect): once it is the edited CSS,
   * the canvas has it, and its debounce (userCssDelayMs) runs from then.
   */
  committedCss: string;
}

declare global {
  interface Window {
    __hbInspector?: InspectorDevGlobals;
  }
}

/** Demo Style-view snippets (the snippets lane provides the real ones through the same slot). */
function DemoSnippets({ api }: { api: StyleEditorApi }) {
  const items: MenuEntry[] = [
    { id: 'page-bg', label: 'Page background', onSelect: () => api.insert('\n.page {\n  background: #fdf6e3;\n}\n') },
    { id: 'drop-cap', label: 'Remove drop caps', onSelect: () => api.insert('\n.page h1 + p::first-letter {\n  all: unset;\n}\n') },
  ];
  return <MenuButton label="Snippets" size="sm" items={items} menuLabel="Style snippets" data-testid="style-snippets" />;
}

/**
 * /dev/inspector[?theme=5ePHB&scheme=system|light|dark]: EditorCanvas with pagination, the
 * Inspector in the right drawer and the Style drawer on the left, wired to the real UI store.
 * The frame's data-theme-status turns "ready" when theme, CSS and fonts are applied.
 */
export function InspectorDevPage() {
  const params = new URLSearchParams(window.location.search);
  const [theme, setTheme] = useState(params.get('theme') ?? '5ePHB');
  const [scheme, setScheme] = useState<UiColorScheme>((params.get('scheme') as UiColorScheme | null) ?? 'system');
  const [css, setCss] = useState('');
  const [status, setStatus] = useState<CanvasStatus>({ state: 'loading', theme });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [repaginations, setRepaginations] = useState(0);
  const styleRef = useRef<StyleEditorHandle | null>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const styleToggle = useRef<HTMLButtonElement>(null);

  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo(() => [Pagination.configure({ isReady: gate.isReady }), PageObjects], [gate]);
  const panels = useUiStore(useShallow((s) => ({ style: s.panels.style, inspector: s.panels.inspector })));
  const togglePanel = useUiStore((s) => s.togglePanel);

  const onReady = useCallback((next: Editor, handle: EditorCanvasHandle) => {
    const selectedObjects: PageObjectRef[] = [];
    next.view.dom.addEventListener(OBJECT_SELECT_EVENT, (event) => selectedObjects.push((event as CustomEvent<PageObjectRef>).detail));
    window.__hbInspector = { editor: next, handle, style: () => styleRef.current, repaginations: [], selectedObjects, settled: () => isSettled(next.state), selectedObject: () => selectedObject(next.state), committedCss: '' };
    setEditor(next);
  }, []);
  // After the canvas's own effects of the same commit (children's effects run first), so its
  // debounce of this CSS is set when this reports it.
  useEffect(() => {
    if (window.__hbInspector) window.__hbInspector.committedCss = css;
  }, [css, editor]);
  const onCssChange = useCallback((next: string) => setCss(next), []);
  const onRepaginate = useCallback((event: RepaginateEvent) => {
    window.__hbInspector?.repaginations.push(event);
    setRepaginations((n) => n + 1);
  }, []);

  return (
    <UiRoot colorScheme={scheme} surface={false} className={styles.page} data-theme-status={status.state}>
      <header className={styles.bar}>
        <IconButton
          ref={styleToggle}
          icon="braces"
          label="Style drawer"
          aria-expanded={panels.style.open}
          aria-controls={panels.style.open ? 'dev-style-drawer' : undefined}
          onClick={() => togglePanel('style')}
          data-testid="toggle-style"
        />
        <h1 className={styles.title}>Inspector and Style drawer</h1>
        <Select
          label="Theme"
          hideLabel
          value={theme}
          options={THEMES.map((t) => ({ value: t, label: t }))}
          onChange={(event) => setTheme(event.target.value)}
          data-testid="theme-select"
        />
        <Select
          label="Colour scheme"
          hideLabel
          value={scheme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(event) => setScheme(event.target.value as UiColorScheme)}
          data-testid="scheme-select"
        />
        <output className={styles.status} data-testid="canvas-status">
          {status.state === 'ready' ? `${status.theme} ready` : status.state === 'error' ? status.message : 'Loading…'} · repaginations:{' '}
          <span data-testid="repaginate-count">{repaginations}</span>
        </output>
        <IconButton
          ref={inspectorToggle}
          icon="panelRight"
          label="Inspector"
          aria-expanded={panels.inspector.open}
          aria-controls={panels.inspector.open ? 'dev-inspector-drawer' : undefined}
          onClick={() => togglePanel('inspector')}
          data-testid="toggle-inspector"
        />
      </header>
      <SplitPanel className={styles.split}>
        <StylePanel
          id="dev-style-drawer"
          ref={styleRef}
          value={css}
          onChange={onCssChange}
          snippets={(api) => <DemoSnippets api={api} />}
          returnFocusRef={styleToggle}
        />
        <SplitMain className={styles.main}>
          <EditorCanvas
            className={styles.canvas}
            content={inspectorDoc}
            theme={theme}
            userCss={css}
            extensions={extensions}
            gate={gate}
            onReady={onReady}
            onStatusChange={setStatus}
            onRepaginate={onRepaginate}
          />
        </SplitMain>
        <InspectorPanel id="dev-inspector-drawer" editor={editor} returnFocusRef={inspectorToggle} />
      </SplitPanel>
    </UiRoot>
  );
}
