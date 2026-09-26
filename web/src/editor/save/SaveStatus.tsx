// The save status for the toolbar (plan §6.2 "save status"): an icon and label, the action the
// state calls for (Save, Retry, Sign in to save, Resolve…, Save as a new brew) with the
// explanation as its tooltip and description, and a polite live region that announces problems
// and manual saves (not every autosave, which would be noise).
import clsx from 'clsx';
import { requestSignIn } from '@/api';
import { Button, Icon, Tooltip, VisuallyHidden } from '@/ui';
import styles from './save.module.css';
import { formatSavedAt, saveStatusInfo } from './statusText';
import type { UseAutosaveResult } from './useAutosave';

export interface SaveStatusProps {
  autosave: UseAutosaveResult;
  /** "Sign in to save" (default: requestSignIn(), which the app's sign-in prompt listens to). */
  onSignIn?: () => void;
  className?: string;
}

export function SaveStatus({ autosave, onSignIn, className }: SaveStatusProps) {
  const info = saveStatusInfo(autosave);
  const { status } = autosave;

  let announcement = '';
  if (status === 'saved' && autosave.lastTrigger === 'now' && autosave.lastSavedAt) {
    announcement = `Saved at ${formatSavedAt(autosave.lastSavedAt)}.`;
  } else if (status === 'offline' || status === 'signedOut' || status === 'conflict' || status === 'error' || status === 'lost') {
    announcement = `${info.label}. ${info.description}`;
  }

  let action = null;
  if (status === 'dirty') {
    action = (
      <Tooltip content="Save now" shortcut="Ctrl+S" describe={false}>
        <Button size="sm" variant="ghost" onClick={() => void autosave.saveNow()} aria-keyshortcuts="Control+S Meta+S">
          Save
        </Button>
      </Tooltip>
    );
  } else if (status === 'offline' || status === 'error') {
    action = (
      <Tooltip content={info.description}>
        <Button size="sm" variant="ghost" onClick={() => void autosave.saveNow()}>
          Retry
        </Button>
      </Tooltip>
    );
  } else if (status === 'signedOut') {
    action = (
      <Tooltip content={info.description}>
        <Button size="sm" variant="primary" icon="user" onClick={onSignIn ?? (() => requestSignIn())}>
          Sign in to save
        </Button>
      </Tooltip>
    );
  } else if (status === 'conflict') {
    action = (
      <Tooltip content={info.description}>
        <Button size="sm" variant="danger" onClick={autosave.openConflict} aria-haspopup="dialog">
          Resolve…
        </Button>
      </Tooltip>
    );
  } else if (status === 'lost') {
    action = (
      <Tooltip content={info.description}>
        <Button size="sm" variant="primary" onClick={() => void autosave.saveAsCopy()}>
          Save as a new brew
        </Button>
      </Tooltip>
    );
  }

  return (
    <div className={clsx(styles.status, className)} data-status={status} data-tone={info.tone} data-testid="save-status">
      <span className={styles.statusLabel} title={info.description} data-testid="save-status-label">
        <Icon name={info.icon} className={styles.statusIcon} />
        {info.label}
      </span>
      {action}
      <VisuallyHidden role="status" aria-live="polite" data-testid="save-status-live">
        {announcement}
      </VisuallyHidden>
    </div>
  );
}
