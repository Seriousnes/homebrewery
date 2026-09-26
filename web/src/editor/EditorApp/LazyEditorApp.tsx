// EditorApp in its own chunk. The page routes (/, /new, /edit, /share) stay small, so a navigation
// to them completes at once and shows the page's heading and a spinner while the editor (TipTap,
// pagination, panels) loads; the pages share that one chunk.
import { lazy, Suspense } from 'react';
import { PageLoading } from '@/app/PageLoading';
import type { EditorAppProps } from './EditorApp';
import styles from './EditorApp.module.css';
import { displayTitle, metaFromInput } from './editorAppModel';

const EditorAppChunk = lazy(() => import('./EditorApp').then((m) => ({ default: m.EditorApp })));

export function LazyEditorApp(props: EditorAppProps) {
  const { heading, brew, initialMetaInput } = props;
  const title = displayTitle(metaFromInput(initialMetaInput, brew.meta).title);
  const text = typeof heading === 'function' ? heading(title) : heading;
  return (
    <Suspense
      fallback={
        <>
          {text ? (
            <h1 className={styles.srOnly} tabIndex={-1} data-route-focus="">
              {text}
            </h1>
          ) : null}
          <PageLoading label="Loading the editor…" />
        </>
      }
    >
      <EditorAppChunk {...props} />
    </Suspense>
  );
}
