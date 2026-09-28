// A searchable, grouped snippet picker (plan §6.3; port of upstream's snippet bar,
// legacy/client/homebrew/editor/snippetbar). A button opens a popover with the snippet list
// (SnippetList: a search combobox over a grouped listbox). Enter or a click picks the active
// snippet; Escape closes (focus back to the button). Used by the Style drawer (style view); the
// Insert menu opens the SnippetGallery dialog instead, with previews.
import { useId, useRef, useState, type ReactNode } from 'react';
import { Button, Popover } from '@/ui';
import type { SnippetEntry } from '@/editor/snippets/snippetTree';
import type { ThemeSnippetGroup } from '@/editor/snippets/themeSnippets';
import { SnippetList } from './SnippetList';
import styles from './SnippetPicker.module.css';

export interface SnippetPickerProps {
  /** Snippet groups of one view (see groupsForView). */
  groups: readonly ThemeSnippetGroup[];
  /** Called with the picked snippet after the popover closed. */
  onPick: (entry: SnippetEntry) => void;
  /** Trigger text (default "Insert"). */
  label?: string;
  /** Name of the popover (default "Insert snippet"). */
  dialogLabel?: string;
  /** An insertion is running: the trigger shows a spinner (it stays focusable). */
  busy?: boolean;
  /** The groups are still loading. */
  loading?: boolean;
  disabled?: boolean;
  /** Called when the popover opens (e.g. to prepare the insertion pipeline). */
  onOpen?: () => void;
  /** Extra content after the list (e.g. a status line). */
  footer?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

export function SnippetPicker({
  groups,
  onPick,
  label = 'Insert',
  dialogLabel = 'Insert snippet',
  busy = false,
  loading = false,
  disabled = false,
  onOpen,
  footer,
  className,
  'data-testid': testId,
}: SnippetPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverId = `${useId()}-popover`;

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (next) onOpen?.();
  };

  return (
    <>
      <Button
        ref={triggerRef}
        icon="insert"
        iconEnd="chevronDown"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        loading={busy}
        disabled={disabled}
        className={className}
        data-testid={testId}
        onClick={() => setOpenState(!open)}
      >
        {label}
      </Button>
      <Popover
        open={open}
        onOpenChange={(next) => setOpenState(next)}
        anchorRef={triggerRef}
        id={popoverId}
        aria-label={dialogLabel}
        initialFocus={inputRef}
        className={styles.panel}
        data-testid={testId ? `${testId}-popover` : undefined}
      >
        <SnippetList
          groups={groups}
          loading={loading}
          inputRef={inputRef}
          className={styles.body}
          onPick={(entry) => {
            setOpen(false);
            onPick(entry);
          }}
        />
        {footer}
      </Popover>
    </>
  );
}
