import { type KeyboardEvent, useId, useRef, useState } from 'react';
import type { EditResult } from '@/editor/commands/attrs';
import { Button, IconButton, TextField } from '@/ui';
import { useAnnounce } from './announce';
import { CommitField } from './CommitField';
import styles from './Inspector.module.css';

export interface AttributesFieldProps {
  attributes: Readonly<Record<string, string>>;
  /** Sets `name` (a new attribute, or a new value when `previousName` is the same name). */
  onSet: (name: string, value: string, previousName?: string) => EditResult;
  onRemove: (name: string) => EditResult;
  'data-testid'?: string;
}

/**
 * The generic `attributes` map (plan §3.5): data-*, aria-*, title, lang, dir and role. Existing
 * values are edited in place; a new attribute is added with the name and value boxes below.
 */
export function AttributesField({ attributes, onSet, onRemove, 'data-testid': testId }: AttributesFieldProps) {
  const legendId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const announce = useAnnounce();
  const entries = Object.entries(attributes);

  const add = () => {
    const result = onSet(name, value);
    if (!result.ok) {
      setError(result.error);
      announce(`Attributes: ${result.error}`);
      return;
    }
    setName('');
    setValue('');
    setError(null);
    nameRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      add();
    }
  };
  const remove = (key: string) => {
    const result = onRemove(key);
    if (!result.ok) announce(`Attributes: ${result.error}`);
    else nameRef.current?.focus();
  };

  return (
    <fieldset className={styles.fieldset} aria-labelledby={legendId} data-testid={testId}>
      <legend id={legendId} className={styles.fieldLabel}>
        Attributes
      </legend>
      {entries.length > 0 ? (
        <ul className={styles.attrList}>
          {entries.map(([key, current]) => (
            <li key={key} className={styles.attrRow}>
              <CommitField
                label={key}
                value={current}
                className={styles.grow}
                onCommit={(text) => onSet(key, text, key)}
                data-testid={testId ? `${testId}-value-${key}` : undefined}
              />
              <IconButton icon="trash" size="sm" label={`Remove attribute ${key}`} tooltip={false} onClick={() => remove(key)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.none}>None</p>
      )}
      <div className={styles.attrAdd}>
        <TextField
          ref={nameRef}
          label="Name"
          placeholder="data-…"
          value={name}
          spellCheck={false}
          autoComplete="off"
          error={error ?? undefined}
          className={styles.grow}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          data-testid={testId ? `${testId}-name` : undefined}
        />
        <TextField
          label="Value"
          value={value}
          spellCheck={false}
          autoComplete="off"
          className={styles.grow}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid={testId ? `${testId}-new-value` : undefined}
        />
        <Button size="sm" icon="plus" onClick={add} aria-label="Add attribute" className={styles.attrAddButton} data-testid={testId ? `${testId}-add` : undefined}>
          Add
        </Button>
      </div>
    </fieldset>
  );
}
