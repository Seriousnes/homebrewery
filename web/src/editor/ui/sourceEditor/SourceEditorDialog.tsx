// "Edit source" (T5): the document's HTML in a code editor, for what the WYSIWYG tools can't do.
//
// Scopes: the blocks at the caret or in the selection (default), the caret's section (its page
// settings on <div class="page"> and its whole flow, auto pages merged), or the whole brew (one
// div.page per section). The source is taken when the dialog opens (or the scope changes).
//
// Apply parses the text (editor/source/parse.ts). When the parse reports problems (markup the
// sanitizer removed, elements that became raw HTML, tags without an equivalent), they are listed
// first and the button becomes "Apply anyway"; applying is one undo step that replaces exactly
// the scope (editor/source/apply.ts). Cancel, Escape and the close button change nothing; with
// edits in the source they ask first.
import type { Editor } from '@tiptap/core';
import { useId, useRef, useState } from 'react';
import { closeUndoGroup, shortcutLabel } from '@/editor/commands/keymap';
import {
  buildApplyTransaction,
  parseSourceFor,
  sectionsOf,
  SourceApplyError,
  sourceOf,
  targetFor,
  type SourceProblem,
  type SourceScope,
  type SourceSnapshot,
} from '@/editor/source';
import { Button, ConfirmDialog, Dialog, Icon } from '@/ui';
import { MarkdownDialog } from './MarkdownDialog';
import { SourceCodeEditor, type SourceCodeEditorHandle } from './SourceCodeEditor';
import styles from './SourceEditor.module.css';

export interface SourceEditorDialogProps {
  editor: Editor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The scope it opens with (default 'selection'). */
  scope?: SourceScope;
  'data-testid'?: string;
}

const SCOPES: readonly { id: SourceScope; label: string; description: string }[] = [
  { id: 'selection', label: 'Selection', description: 'The blocks at the caret or in the selection.' },
  { id: 'section', label: 'Section', description: 'This section: its page settings on <div class="page"> and its whole flow.' },
  { id: 'brew', label: 'Whole brew', description: 'Every section, one <div class="page"> each.' },
];

function snapshotFor(editor: Editor, scope: SourceScope): SourceSnapshot {
  const state = editor.state;
  const sections = sectionsOf(state.doc);
  return sourceOf(editor.schema, state.doc, targetFor(state, scope, sections), sections);
}

export function SourceEditorDialog({ open, ...rest }: SourceEditorDialogProps) {
  // Mounted only while open: the source is read fresh on every open.
  return open ? <SourceEditorDialogContent {...rest} /> : null;
}

type Pending = { kind: 'close' } | { kind: 'scope'; scope: SourceScope };

function SourceEditorDialogContent({ editor, onOpenChange, scope: initialScope = 'selection', 'data-testid': testId = 'source-editor' }: Omit<SourceEditorDialogProps, 'open'>) {
  const [scope, setScope] = useState<SourceScope>(initialScope);
  const [snapshot, setSnapshot] = useState(() => snapshotFor(editor, initialScope));
  const [text, setText] = useState(snapshot.text);
  const [generation, setGeneration] = useState(0);
  const [report, setReport] = useState<{ text: string; problems: SourceProblem[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [markdownOpen, setMarkdownOpen] = useState(false);
  const codeRef = useRef<SourceCodeEditorHandle>(null);
  const hintId = useId();
  const reportId = useId();
  const dirty = text !== snapshot.text;
  const shownReport = report && report.text === text ? report : null;

  const switchTo = (next: SourceScope) => {
    const fresh = snapshotFor(editor, next);
    setScope(next);
    setSnapshot(fresh);
    setText(fresh.text);
    setGeneration((g) => g + 1);
    setReport(null);
    setError(null);
  };

  const requestScope = (next: SourceScope) => {
    if (next === scope) return;
    if (dirty) setPending({ kind: 'scope', scope: next });
    else switchTo(next);
  };

  const requestClose = (nextOpen: boolean) => {
    if (nextOpen) return;
    if (dirty) setPending({ kind: 'close' });
    else onOpenChange(false);
  };

  const apply = () => {
    const current = codeRef.current?.getValue() ?? text;
    setError(null);
    if (current === snapshot.text) {
      onOpenChange(false);
      return;
    }
    let parsed;
    try {
      parsed = parseSourceFor(editor.schema, snapshot.target, current, snapshot.rawHtml);
    } catch (e) {
      setError(`The source could not be read: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (parsed.problems.length > 0 && report?.text !== current) {
      setReport({ text: current, problems: parsed.problems });
      return;
    }
    let tr;
    try {
      tr = buildApplyTransaction(editor.state, snapshot.target, parsed);
    } catch (e) {
      if (!(e instanceof SourceApplyError)) throw e;
      setError(e.message);
      return;
    }
    if (tr && editor.isEditable) {
      // One undo step of its own.
      closeUndoGroup(editor);
      editor.view.dispatch(tr);
      closeUndoGroup(editor);
    }
    onOpenChange(false);
  };

  const scopeInfo = SCOPES.find((s) => s.id === scope)!;
  return (
    <>
      <Dialog
        open
        onOpenChange={requestClose}
        title="Edit source"
        description={
          <>
            {scopeInfo.description} Apply replaces it as one undo step. <span className={styles.keys}>{shortcutLabel('Mod-Enter')} applies.</span>
          </>
        }
        size="lg"
        className={styles.dialog}
        data-testid={testId}
        footer={
          <>
            <Button variant="ghost" icon="insert" aria-haspopup="dialog" className={styles.footerStart} onClick={() => setMarkdownOpen(true)} data-testid="source-from-markdown">
              From markdown…
            </Button>
            <Button variant="ghost" onClick={() => requestClose(false)} data-testid="source-cancel">
              Cancel
            </Button>
            <Button variant="primary" onClick={apply} aria-describedby={shownReport ? reportId : undefined} data-testid="source-apply">
              {shownReport ? 'Apply anyway' : 'Apply'}
            </Button>
          </>
        }
      >
        <div className={styles.body}>
          <fieldset className={styles.scopes} data-testid="source-scope">
            <legend className={styles.legend}>Edit</legend>
            {SCOPES.map((s) => (
              <label key={s.id} className={styles.scope}>
                <input type="radio" name="source-scope" value={s.id} checked={scope === s.id} onChange={() => requestScope(s.id)} data-testid={`source-scope-${s.id}`} />
                {s.label}
              </label>
            ))}
          </fieldset>
          <p id={hintId} className={styles.hint}>
            HTML as the themes see it. Page ids, auto pages and generated heading ids are left out; pagination lays the pages out again.
          </p>
          <SourceCodeEditor
            key={generation}
            ref={codeRef}
            initialValue={snapshot.text}
            onChange={setText}
            onSubmit={apply}
            label={`Source: ${scopeInfo.label}`}
            describedBy={hintId}
            data-testid="source-code"
          />
          {shownReport ? (
            <div id={reportId} className={styles.report} role="alert" data-testid="source-report">
              <p className={styles.reportTitle}>
                <Icon name="warning" size={16} /> Check before applying: not everything in the source can be kept.
              </p>
              <ul className={styles.problems}>
                {shownReport.problems.map((problem) => (
                  <li key={problem.message} data-kind={problem.kind}>
                    {problem.message}
                    {problem.count > 1 ? <span className={styles.count}> ({problem.count}×)</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert" data-testid="source-error">
              <Icon name="error" size={16} /> {error}
            </p>
          ) : null}
        </div>
      </Dialog>
      <MarkdownDialog
        open={markdownOpen}
        onOpenChange={setMarkdownOpen}
        schema={editor.schema}
        sections={scope !== 'selection'}
        onInsert={(source) => codeRef.current?.insert(source)}
      />
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title="Discard your changes?"
        message={pending?.kind === 'scope' ? 'Switching the scope reloads the source; your edits are lost.' : 'Your edits to the source are not applied.'}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        tone="danger"
        onConfirm={() => {
          const action = pending;
          setPending(null);
          if (action?.kind === 'scope') switchTo(action.scope);
          else onOpenChange(false);
        }}
      />
    </>
  );
}
