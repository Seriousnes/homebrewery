// The toolbar status of a local brew (issue #4), in SaveStatus's style: where the brew is kept, and
// the next step: "Upload" (signed in) or "Sign in to upload" (signed out), or Retry after a failed
// write. A polite live region announces problems and manual saves.
import clsx from 'clsx';
import { requestSignIn } from '@/api/events';
import { Button, Icon, Tooltip, VisuallyHidden } from '@/ui';
import styles from '../save/save.module.css';
import { localStatusInfo } from './localStatus';
import type { LocalSaveState } from './useLocalSave';

export interface LocalSaveStatusProps {
  state: LocalSaveState & { saveNow: () => Promise<boolean> };
  signedIn: boolean;
  /** Upload to the signed-in user's account (shown once the brew is stored). */
  onUpload?: () => void;
  uploading?: boolean;
  className?: string;
}

export function LocalSaveStatus({ state, signedIn, onUpload, uploading = false, className }: LocalSaveStatusProps) {
  const info = localStatusInfo(state);
  const { status } = state;

  let action = null;
  if (status === 'error') {
    action = (
      <Tooltip content={info.description}>
        <Button size="sm" variant="ghost" onClick={() => void state.saveNow()}>
          Retry
        </Button>
      </Tooltip>
    );
  } else if (state.localId !== null && signedIn && onUpload) {
    action = (
      <Tooltip content="Save this brew to your account; it then leaves this device.">
        <Button size="sm" variant="primary" icon="upload" loading={uploading} onClick={onUpload} data-testid="local-upload">
          Upload
        </Button>
      </Tooltip>
    );
  } else if (!signedIn) {
    action = (
      <Tooltip content="Sign in or create an account to upload this brew to the cloud.">
        <Button size="sm" variant="ghost" icon="user" onClick={() => requestSignIn()} data-testid="local-sign-in">
          Sign in to upload
        </Button>
      </Tooltip>
    );
  }

  const announcement = status === 'error' || (!state.persistent && status !== 'idle') ? `${info.label}. ${info.description}` : '';

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
