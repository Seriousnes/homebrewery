import type { Editor, JSONContent } from '@tiptap/core';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import { createCanvasGate } from '@/editor/canvas/canvasState';
import { EditorCanvas } from '@/editor/canvas/EditorCanvas';
import type { CanvasStatus, RepaginateEvent } from '@/editor/canvas/useCanvasTheme';
import { EditorApp } from '@/editor/EditorApp/EditorApp';
import { editingExtensions } from '@/editor/EditorApp/editorAppExtensions';
import { appBrewForNew, defaultMeta, docForEditor } from '@/editor/EditorApp/editorAppModel';
import { DOC_SCHEMA_VERSION } from '@/editor/schema/version';
import { LayoutStatus } from '@/editor/ui/layoutStatus/LayoutStatus';
import { EditorToolbar } from '@/editor/ui/toolbar';
import { UiRoot } from '@/ui';
import { PerfController, type PerfMount } from './perfController';
import styles from './PerfDevPage.module.css';

/**
 * /dev/perf[?src=<url of a document JSON>&shell=app|canvas&theme=5ePHB]: the P8.1 performance
 * page (plan §4.10). It mounts a document in the real EditorApp ('app') or in EditorCanvas with the
 * app's editing extensions and a switchable theme ('canvas'), and exposes window.__hbPerf
 * (perfController.ts) for web/e2e/perf/perf.spec.ts. A document comes from window.__hbPerfDoc
 * (Playwright's addInitScript), from ?src=, or from __hbPerf.mount(doc).
 */
export function PerfDevPage() {
  const [params] = useSearchParams();
  const [controller] = useState(() => new PerfController(window.__hbPerfDoc ?? null));
  useSyncExternalStore(controller.subscribe, controller.snapshot);

  useEffect(() => {
    controller.start();
    window.__hbPerf = controller.api();
    return () => {
      delete window.__hbPerf;
      controller.stop();
    };
  }, [controller]);

  // ?src=/e2e/fixtures/perf-150.json (the Vite dev server serves files under web/).
  const src = params.get('src');
  useEffect(() => {
    if (!src || controller.current) return;
    const abort = new AbortController();
    fetch(src, { signal: abort.signal })
      .then((r) => r.json() as Promise<JSONContent>)
      .then((doc) => window.__hbPerf?.mount(doc, { shell: params.get('shell') === 'canvas' ? 'canvas' : 'app', theme: params.get('theme') ?? '5ePHB' }))
      .catch(() => undefined);
    return () => abort.abort();
  }, [src, controller, params]);

  const mount = controller.current;
  return (
    <div className={styles.frame} data-perf-shell={mount?.shell ?? 'none'}>
      <header className={styles.bar}>
        <strong>/dev/perf</strong>{' '}
        {mount ? (
          <>
            shell <code>{mount.shell}</code> theme <code>{mount.theme}</code> · {mount.doc.content?.length ?? 0} pages loaded
          </>
        ) : (
          'no document: pass ?src=/e2e/fixtures/perf-150.json or call __hbPerf.mount(doc)'
        )}
      </header>
      <div className={styles.area}>
        {mount === null ? null : mount.shell === 'app' ? <AppShell key={mount.key} mount={mount} /> : <CanvasShell key={mount.key} mount={mount} controller={controller} />}
      </div>
    </div>
  );
}

/** The real editor of the app pages, as the home page mounts it (edit, never saved). */
function AppShell({ mount }: { mount: PerfMount }) {
  const [initial] = useState(() => ({
    content: docForEditor(mount.doc, DOC_SCHEMA_VERSION),
    brew: { ...appBrewForNew(null), meta: defaultMeta({ title: 'Performance fixture', theme: mount.theme }), style: mount.style },
  }));
  return <EditorApp mode="edit" saving="none" content={initial.content} brew={initial.brew} navbar={false} tabTitle={false} data-testid="perf-editor" />;
}

/** EditorCanvas with the app's editing extensions, toolbar and layout status; the theme follows `mount`. */
function CanvasShell({ mount, controller }: { mount: PerfMount; controller: PerfController }) {
  const [content] = useState(() => docForEditor(mount.doc, DOC_SCHEMA_VERSION));
  const gate = useMemo(() => createCanvasGate(), []);
  const extensions = useMemo(() => editingExtensions(gate), [gate]);
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <div className={styles.shell} data-testid="perf-canvas-shell">
      <UiRoot className={styles.chrome}>
        {editor ? <EditorToolbar editor={editor} /> : null}
        <LayoutStatus editor={editor} />
      </UiRoot>
      <div className={styles.canvasArea}>
        <EditorCanvas
          content={content}
          theme={mount.theme}
          userCss={mount.style}
          gate={gate}
          extensions={extensions}
          onReady={setEditor}
          onStatusChange={(status: CanvasStatus) => controller.onStatus(status)}
          onRepaginate={(event: RepaginateEvent) => controller.onRepaginate(event)}
        />
      </div>
    </div>
  );
}
