import { type KeyboardEvent, type ReactNode, useState } from 'react';
import type { EditResult } from '@/editor/commands/attrs';
import { TextArea, TextField } from '@/ui';
import { useAnnounce } from './announce';
import styles from './Inspector.module.css';

export interface CommitFieldProps {
  label: string;
  /** The stored value, shown while the author isn't editing. */
  value: string;
  /** Validates and applies the typed text (one undo step); an error keeps the draft. */
  onCommit: (text: string) => EditResult;
  multiline?: boolean;
  monospace?: boolean;
  hint?: ReactNode;
  placeholder?: string;
  rows?: number;
  hideLabel?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * A text field that edits a document value: typing only changes a draft; Enter (Ctrl+Enter or
 * Cmd+Enter when multi-line) or leaving the field applies it; Escape goes back to the stored
 * value. An invalid draft shows the error inline, stays in the field and changes nothing.
 */
export function CommitField({
  label,
  value,
  onCommit,
  multiline = false,
  monospace = false,
  hint,
  placeholder,
  rows = 3,
  hideLabel,
  className,
  'data-testid': testId,
}: CommitFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const announce = useAnnounce();

  const commit = () => {
    if (draft === null) return;
    if (draft === value) {
      setDraft(null);
      setError(null);
      return;
    }
    const result = onCommit(draft);
    if (result.ok) {
      setDraft(null);
      setError(null);
    } else {
      setError(result.error);
      announce(`${label}: ${result.error}`);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape' && draft !== null) {
      // Handled here, so the Escape doesn't also close a surrounding layer.
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
      setError(null);
    }
  };

  const common = {
    label,
    hint,
    hideLabel,
    className,
    placeholder,
    value: draft ?? value,
    error: error ?? undefined,
    spellCheck: false,
    autoComplete: 'off',
    onChange: (event: { target: { value: string } }) => {
      setDraft(event.target.value);
      setError(null);
    },
    onBlur: commit,
    onKeyDown,
    'data-testid': testId,
    'data-dirty': draft !== null && draft !== value ? '' : undefined,
    inputClassName: monospace ? styles.mono : undefined,
  };
  return multiline ? <TextArea {...common} rows={rows} /> : <TextField {...common} />;
}
