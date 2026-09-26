import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import '@/editor/canvas/canvas.css';
import { applyThemeStyles, loadThemeChain, waitForFonts, type ThemeChain } from '@/editor/canvas/themeLoader';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { schemaDevDoc } from './devDoc';
import styles from './SchemaDevPage.module.css';

const extensions = buildEditorExtensions();

type Status = { state: 'loading' } | { state: 'ready'; chain: ThemeChain; failed: string[] } | { state: 'error'; message: string };

/**
 * /dev/schema[?theme=5ePHB]: a plain TipTap editor (buildEditorExtensions, no NodeViews, no
 * pagination) inside div.hb-canvas with the theme chain applied through themeLoader and the
 * editor rules of canvas.css. `data-theme-status` on the frame turns "ready" once the theme
 * sheets and fonts are loaded (e2e/dev-schema.spec.ts waits for it).
 */
export function SchemaDevPage() {
  const [params] = useSearchParams();
  const theme = params.get('theme') ?? '5ePHB';
  const [status, setStatus] = useState<Status>({ state: 'loading' });

  const editor = useEditor({
    extensions,
    content: schemaDevDoc,
    shouldRerenderOnTransaction: false,
  });

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const load = async () => {
      const chain = await loadThemeChain(theme);
      const applied = await applyThemeStyles(chain);
      dispose = applied.dispose;
      if (cancelled) return;
      await waitForFonts({ root: document.querySelector('.hb-canvas') });
      if (!cancelled) setStatus({ state: 'ready', chain, failed: applied.failed });
    };
    load().catch((error: unknown) => {
      if (!cancelled) setStatus({ state: 'error', message: String(error) });
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [theme]);

  return (
    <div className={styles.frame} data-theme-status={status.state}>
      <header className={styles.bar}>
        <strong>/dev/schema</strong> theme <code>{theme}</code>:{' '}
        {status.state === 'ready'
          ? `${status.chain.source} chain ${status.chain.snippets.map((s) => (typeof s === 'string' ? s : s.name)).join(' → ')}${status.failed.length ? `, failed: ${status.failed.join(', ')}` : ''}`
          : status.state === 'error'
            ? status.message
            : 'loading…'}
      </header>
      <EditorContent editor={editor} className={`hb-canvas ${styles.canvas}`} lang="en" />
    </div>
  );
}
