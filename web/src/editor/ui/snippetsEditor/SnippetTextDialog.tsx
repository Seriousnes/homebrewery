// Import and export of the brew's snippets in upstream's text form ("\snippet name" lines, see
// snippets/snippetText.ts). Import: paste text or open a file, then add the snippets after the
// brew's own or replace them (one undo step either way). Export: the text, to copy or download.
import { type ChangeEvent, useId, useMemo, useRef, useState } from 'react';
import { parseSnippetText, snippetsToText } from '@/editor/snippets/snippetText';
import { Button, Dialog, TextArea } from '@/ui';
import { exportFileName, MAX_IMPORT_FILE_BYTES, plural } from './helpers';
import type { EditableSnippet } from './snippetsModel';
import type { SnippetsEditorStore } from './snippetsEditorStore';
import styles from './SnippetsEditor.module.css';

export interface SnippetTextDialogProps {
  /** Which dialog is open (null: none). */
  mode: 'import' | 'export' | null;
  onClose: () => void;
  store: SnippetsEditorStore;
  snippets: readonly EditableSnippet[];
  brewTitle: string;
}

export function SnippetTextDialog({ mode, onClose, store, snippets, brewTitle }: SnippetTextDialogProps) {
  if (mode === 'import') return <ImportDialog onClose={onClose} store={store} />;
  if (mode === 'export') return <ExportDialog onClose={onClose} snippets={snippets} brewTitle={brewTitle} />;
  return null;
}

function ImportDialog({ onClose, store }: { onClose: () => void; store: SnippetsEditorStore }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileId = useId();
  const parsed = useMemo(() => parseSnippetText(text), [text]);
  const found = parsed.snippets.length;

  const summary = !text.trim()
    ? 'Paste snippets or open a file.'
    : found
      ? [
          `Found ${plural(found, 'snippet', 'snippets')}: ${parsed.snippets.map((s) => s.name).join(', ')}.`,
          parsed.ignored ? 'Text before the first \\snippet line is left out.' : '',
          parsed.skipped ? `${plural(parsed.skipped, 'snippet', 'snippets')} without a name ${parsed.skipped === 1 ? 'is' : 'are'} left out.` : '',
        ]
          .filter(Boolean)
          .join(' ')
      : 'No \\snippet lines found.';

  const run = (mode: 'append' | 'replace') => {
    if (!found) return;
    const keys = store.importSnippets(parsed.snippets, mode);
    if (!keys.length) {
      setError('These snippets would make the brew’s snippets larger than 2 MB.');
      return;
    }
    store.announce(`${mode === 'replace' ? 'Replaced the snippets with' : 'Imported'} ${plural(keys.length, 'snippet', 'snippets')}.`);
    onClose();
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setError(`“${file.name}” is too large (the limit is 8 MB).`);
      return;
    }
    try {
      setText(await file.text());
      setError(null);
    } catch {
      setError(`“${file.name}” couldn’t be read.`);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Import snippets"
      description="Snippets in Homebrewery’s text form: a line “\snippet name” (or “\snippet group › name”) starts each one, its markdown follows."
      size="lg"
      data-testid="snippets-import-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button aria-disabled={!found} onClick={() => run('replace')} data-testid="snippets-import-replace">
            Replace all
          </Button>
          <Button variant="primary" aria-disabled={!found} onClick={() => run('append')} data-testid="snippets-import-add">
            {found ? `Add ${plural(found, 'snippet', 'snippets')}` : 'Add snippets'}
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <TextArea
          label="Snippet text"
          value={text}
          rows={10}
          spellCheck={false}
          data-autofocus=""
          inputClassName={styles.mono}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          data-testid="snippets-import-text"
        />
        <div className={styles.file}>
          <label htmlFor={fileId}>Or open a text file</label>
          <input id={fileId} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(e) => void onFile(e)} data-testid="snippets-import-file" />
        </div>
        <p role="status" className={styles.hint} data-testid="snippets-import-summary">
          {summary}
        </p>
        {error ? (
          <p role="alert" className={styles.dialogError} data-testid="snippets-import-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function ExportDialog({ onClose, snippets, brewTitle }: { onClose: () => void; snippets: readonly EditableSnippet[]; brewTitle: string }) {
  const { text, unnamed } = useMemo(() => {
    const named = snippets.filter((s) => s.name.trim());
    return { text: snippetsToText(named), unnamed: snippets.length - named.length };
  }, [snippets]);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      // No clipboard access: select the text, so Ctrl+C copies it.
      textRef.current?.focus();
      textRef.current?.select();
      setCopied('failed');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFileName(brewTitle);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Export snippets"
      description="The brew’s snippets in Homebrewery’s text form. Import them into another brew, or paste them into a Homebrewery Snippets tab."
      size="lg"
      data-testid="snippets-export-dialog"
      footer={
        <>
          <Button icon="download" onClick={download} data-testid="snippets-export-download">
            Download
          </Button>
          <Button icon="copy" onClick={() => void copy()} data-testid="snippets-export-copy">
            Copy
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <TextArea ref={textRef} label="Snippet text" value={text} readOnly rows={12} spellCheck={false} inputClassName={styles.mono} data-testid="snippets-export-text" />
        <p role="status" className={styles.hint} data-testid="snippets-export-status">
          {copied === 'copied' ? 'Copied to the clipboard.' : copied === 'failed' ? 'The text is selected: press Ctrl+C (⌘C on a Mac) to copy it.' : ''}
          {unnamed ? ` ${plural(unnamed, 'snippet', 'snippets')} without a name ${unnamed === 1 ? 'is' : 'are'} left out.` : ''}
        </p>
      </div>
    </Dialog>
  );
}
