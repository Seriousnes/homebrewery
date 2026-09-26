import type { Editor } from '@tiptap/core';
import { clsx } from 'clsx';
import {
  addClasses,
  editId,
  editStyle,
  removeAttribute,
  removeClass,
  setAttribute,
  type Dispatch,
  type EditResult,
  type EditTarget,
} from '@/editor/commands/attrs';
import type { EditorState } from '@tiptap/pm/state';
import { Button } from '@/ui';
import { AttributesField } from './AttributesField';
import { ClassField } from './ClassField';
import { CommitField } from './CommitField';
import type { ClassPickerMode } from '../classPicker/themeClasses';
import type { ClassSuggester } from './classNames';
import styles from './Inspector.module.css';
import type { ChainItem, InspectorSnapshot, InspectorStore } from './model';

export interface NodePanelProps {
  editor: Editor;
  store: InspectorStore;
  snapshot: InspectorSnapshot;
  suggestions: (mode: ClassPickerMode) => ClassSuggester;
  /** The editor is read-only: the fields show the values, disabled. */
  readOnly?: boolean;
}

const STALE: EditResult = { ok: false, error: 'The selection changed before the edit was applied; nothing was changed.' };
/** An edit attempted while the editor is read-only (the fields are disabled then). */
const READ_ONLY: EditResult = { ok: false, error: 'The document is read-only; nothing was changed.' };

/** Breadcrumbs of the element chain plus the generic attributes of the inspected element. */
export function NodePanel({ editor, store, snapshot, suggestions, readOnly = false }: NodePanelProps) {
  const item = snapshot.chain.find((c) => c.key === snapshot.targetKey);
  if (!item) {
    return (
      <p className={styles.placeholder} data-testid="inspector-empty">
        Place the cursor in a page, or select an element, to edit its classes, style, id and attributes.
      </p>
    );
  }
  const targetId = snapshot.targetId;
  /** Runs an edit on the inspected element as it is now; refuses if another element is inspected. */
  const edit = (run: (state: EditorState, dispatch: Dispatch, target: EditTarget) => EditResult): EditResult => {
    const resolved = store.target();
    if (!resolved || store.getSnapshot().targetId !== targetId || editor.isDestroyed) return STALE;
    if (!editor.isEditable) return READ_ONLY;
    return run(editor.state, (tr) => editor.view.dispatch(tr), resolved.target);
  };

  return (
    <div className={styles.panel}>
      <Breadcrumbs chain={snapshot.chain} current={item.key} onSelect={(key) => store.select(key)} />
      <div className={styles.targetHeader}>
        <h3 className={styles.targetTitle} data-testid="inspector-target">
          {item.label}
        </h3>
        {item.continued ? <p className={styles.note}>Split across pages: changes apply to every part.</p> : null}
      </div>
      <fieldset key={targetId} className={clsx(styles.fields, styles.bareFieldset)} disabled={readOnly}>
        <ClassField
          label="Classes"
          classes={item.values.classes}
          suggestions={() => suggestions(item.kind === 'mark' ? 'span' : 'themeBlock')}
          onAdd={(text) => edit((s, d, t) => addClasses(s, d, t, text))}
          onRemove={(name) => edit((s, d, t) => removeClass(s, d, t, name))}
          data-testid="inspector-classes"
        />
        <CommitField
          label="Style"
          multiline
          monospace
          rows={3}
          value={item.values.style ?? ''}
          placeholder="color: darkred; margin-top: 4px"
          hint="CSS declarations. Ctrl+Enter or leaving the field applies them."
          onCommit={(text) => edit((s, d, t) => editStyle(s, d, t, text))}
          data-testid="inspector-style"
        />
        <IdField item={item} onCommit={(text) => edit((s, d, t) => editId(s, d, t, text))} />
        <AttributesField
          attributes={item.values.attributes}
          onSet={(name, value, previous) => edit((s, d, t) => setAttribute(s, d, t, name, value, previous))}
          onRemove={(name) => edit((s, d, t) => removeAttribute(s, d, t, name))}
          data-testid="inspector-attributes"
        />
      </fieldset>
    </div>
  );
}

function Breadcrumbs({ chain, current, onSelect }: { chain: readonly ChainItem[]; current: string; onSelect: (key: string) => void }) {
  return (
    <nav aria-label="Element path" className={styles.crumbs} data-testid="inspector-breadcrumbs">
      <ol className={styles.crumbList}>
        {chain.map((c, i) => (
          <li key={c.key} className={styles.crumbItem}>
            {i > 0 ? (
              <span aria-hidden="true" className={styles.crumbSep}>
                ›
              </span>
            ) : null}
            <button
              type="button"
              className={clsx(styles.crumb, c.key === current && styles.crumbCurrent)}
              aria-current={c.key === current ? 'true' : undefined}
              onClick={() => onSelect(c.key)}
            >
              {c.label}
              {c.values.classes.length > 0 ? <span className={styles.crumbClasses}>.{c.values.classes.slice(0, 2).join('.')}</span> : null}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function IdField({ item, onCommit }: { item: ChainItem; onCommit: (text: string) => EditResult }) {
  const heading = item.type === 'heading';
  const hint = heading
    ? item.customId
      ? 'Your own id. Clear it to use the id generated from the heading text.'
      : 'Generated from the heading text. Type another to set your own.'
    : 'Target of #links. Must be unique.';
  return (
    <div className={styles.idRow}>
      <CommitField
        label="Id"
        value={item.values.id ?? ''}
        placeholder="none"
        hint={hint}
        className={styles.grow}
        onCommit={onCommit}
        data-testid="inspector-id"
      />
      {heading && item.customId ? (
        <Button size="sm" variant="ghost" className={styles.idReset} onClick={() => onCommit('')} data-testid="inspector-id-reset">
          Use generated id
        </Button>
      ) : null}
    </div>
  );
}
