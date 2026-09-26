import { type FormEvent, useId, useRef, useState } from 'react';
import { Button, Dialog, TextField } from '@/ui';
import { hrefProblem, normalizeHref } from '../../commands/marks';
import styles from './LinkDialog.module.css';

export interface LinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The current link's address (editing), or ''. */
  initialHref?: string;
  /** Ask for the link text too (nothing is selected and the cursor isn't in a link). */
  askText?: boolean;
  /** Editing an existing link: offers "Remove link". */
  editing?: boolean;
  /** Called with a checked address (http, https, mailto, relative or #anchor). */
  onApply: (href: string, text?: string) => void;
  onRemove?: () => void;
  'data-testid'?: string;
}

/**
 * The link dialog (Mod-K, plan §6.1): address (and text when nothing is selected). A bare domain
 * gets https:// (normalizeHref); addresses outside the URL policy are refused with a message.
 * Enter applies, Escape cancels. Unmounted while closed.
 */
export function LinkDialog(props: LinkDialogProps) {
  return props.open ? <LinkDialogContent {...props} /> : null;
}

function LinkDialogContent({ onOpenChange, initialHref = '', askText = false, editing = false, onApply, onRemove, 'data-testid': testId }: LinkDialogProps) {
  const [href, setHref] = useState(initialHref);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const hrefRef = useRef<HTMLInputElement>(null);
  const formId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeHref(href);
    const problem = hrefProblem(normalized);
    if (problem) {
      setError(problem);
      hrefRef.current?.focus();
      return;
    }
    onApply(normalized, askText ? label : undefined);
    onOpenChange(false);
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title={editing ? 'Edit link' : 'Add a link'}
      initialFocusRef={hrefRef}
      size="sm"
      data-testid={testId}
      footer={
        <div className={styles.footer}>
          {editing && onRemove ? (
            <Button
              variant="ghost"
              onClick={() => {
                onRemove();
                onOpenChange(false);
              }}
              data-testid={testId ? `${testId}-remove` : undefined}
            >
              Remove link
            </Button>
          ) : null}
          <span className={styles.spacer} />
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} data-testid={testId ? `${testId}-apply` : undefined}>
            {editing ? 'Save link' : 'Add link'}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className={styles.form} noValidate>
        <TextField
          ref={hrefRef}
          label="Address"
          hint="A web address (https://…), mailto:, a path on this site, or #heading-id for a place in the brew."
          error={error ?? undefined}
          value={href}
          onChange={(event) => {
            setHref(event.target.value);
            setError(null);
          }}
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
          data-testid={testId ? `${testId}-href` : undefined}
        />
        {askText ? (
          <TextField
            label="Text"
            hint="Shown in the brew. Leave it empty to show the address."
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            data-testid={testId ? `${testId}-text` : undefined}
          />
        ) : null}
      </form>
    </Dialog>
  );
}
