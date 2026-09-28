// The Insert snippet gallery (plan §6.3): a modal dialog, like the brew's Properties, with the
// snippet list (SnippetList: search combobox, grouped listbox, the same keys) on the left and a
// preview of the active snippet on the right, rendered by the insertion pipeline itself
// (loadPreview). Only the active snippet is previewed, once it has been active for a moment
// (moving through the list doesn't convert every snippet on the way); the caller caches.
// Enter, a click on a snippet or Insert picks it; Escape and Cancel close.
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Spinner } from '@/ui';
import type { SnippetPreview } from '@/editor/snippets/preview';
import { pathLabel, type SnippetEntry } from '@/editor/snippets/snippetTree';
import type { ThemeSnippetGroup } from '@/editor/snippets/themeSnippets';
import styles from './SnippetGallery.module.css';
import { SnippetList } from './SnippetList';
import { SnippetPreviewView } from './SnippetPreview';

export interface SnippetGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Snippet groups of the text view. */
  groups: readonly ThemeSnippetGroup[];
  loading?: boolean;
  onPick: (entry: SnippetEntry) => void;
  /** The preview of a snippet (called for the active one; cache the result). */
  loadPreview: (entry: SnippetEntry) => Promise<SnippetPreview>;
  /** The brew's language, for the preview's hyphenation. */
  lang?: string;
  /** Move the focus back to where it was when it opened (default true; false: the caller does). */
  returnFocus?: boolean;
  /** Wait before previewing a newly active snippet (ms, default 150). */
  previewDelayMs?: number;
  'data-testid'?: string;
}

export function SnippetGallery({ open, onOpenChange, groups, loading, onPick, loadPreview, lang, returnFocus = true, previewDelayMs, 'data-testid': testId }: SnippetGalleryProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState<SnippetEntry | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Insert snippet"
      size="lg"
      className={styles.dialog}
      initialFocusRef={inputRef}
      returnFocus={returnFocus}
      data-testid={testId}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!active || active.disabled} onClick={() => active && onPick(active)} data-testid={testId ? `${testId}-insert` : undefined}>
            Insert
          </Button>
        </>
      }
    >
      <div className={styles.layout}>
        <SnippetList groups={groups} loading={loading} inputRef={inputRef} onPick={onPick} onActiveChange={setActive} className={styles.list} />
        <GalleryPreview entry={active} loadPreview={loadPreview} lang={lang} delayMs={previewDelayMs} testId={testId ? `${testId}-preview` : undefined} />
      </div>
    </Dialog>
  );
}

type PreviewState = { entry: SnippetEntry; state: 'loading' } | { entry: SnippetEntry; state: 'ready'; preview: SnippetPreview } | { entry: SnippetEntry; state: 'error'; message: string };

interface GalleryPreviewProps {
  entry: SnippetEntry | null;
  loadPreview: (entry: SnippetEntry) => Promise<SnippetPreview>;
  lang?: string;
  delayMs?: number;
  testId?: string;
}

function GalleryPreview({ entry, loadPreview, lang, delayMs = 150, testId }: GalleryPreviewProps) {
  const [result, setResult] = useState<PreviewState | null>(null);
  const load = useRef(loadPreview);
  useEffect(() => {
    load.current = loadPreview;
  });

  useEffect(() => {
    if (!entry || entry.disabled) return;
    let live = true;
    const timer = setTimeout(() => {
      setResult({ entry, state: 'loading' });
      load.current(entry).then(
        (preview) => {
          if (live) setResult({ entry, state: 'ready', preview });
        },
        (error: unknown) => {
          if (live) setResult({ entry, state: 'error', message: error instanceof Error ? error.message : String(error) });
        },
      );
    }, delayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [entry, delayMs]);

  if (!entry) {
    return (
      <div className={styles.preview} data-testid={testId} data-state="empty">
        <p className={styles.placeholder}>No snippet selected.</p>
      </div>
    );
  }
  // Until the new entry's preview is on its way, it is loading (not the previous entry's).
  const current: PreviewState = result?.entry === entry ? result : { entry, state: 'loading' };
  const note = current.state === 'ready' ? current.preview.note : null;
  return (
    <div className={styles.preview} data-testid={testId} data-state={current.state} data-preview-snippet={entry.path.join(' › ')}>
      <div className={styles.heading}>
        <h3 className={styles.name}>{entry.name}</h3>
        <span className={styles.path}>{pathLabel(entry.path.slice(0, -1))}</span>
      </div>
      {entry.hint ? <p className={styles.hint}>{entry.hint}</p> : null}
      <div className={styles.stage}>
        {current.state === 'ready' && current.preview.doc ? (
          <SnippetPreviewView preview={current.preview} label={`Preview of ${entry.name}`} lang={lang} className={styles.view} data-testid={testId ? `${testId}-view` : undefined} />
        ) : current.state === 'loading' ? (
          <div className={styles.placeholder}>
            {/* Not announced: the list's status and the active option already speak. */}
            <Spinner decorative size={24} />
          </div>
        ) : current.state === 'error' ? (
          <p className={styles.error} role="alert">
            No preview: {current.message}
          </p>
        ) : (
          <p className={styles.placeholder}>Nothing to show.</p>
        )}
      </div>
      {note ? <p className={styles.note}>{note}</p> : null}
    </div>
  );
}
