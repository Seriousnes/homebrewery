// Asks before an in-app navigation leaves changes that can't be saved (SAVE-2): beforeunload
// covers closing and reloading the tab, but a link inside the app (the navbar's Home, Share →
// View the share page, New brew, recent brews) only unmounts the editor. While
// autosave.controller.shouldWarnOnUnload('app') holds (a conflict, a lost brew, offline, an
// error, a save stuck in flight), a navigation to another path is held and this dialog asks:
// "Save mine as a copy" (conflict or lost brew; then the navigation goes on), "Leave anyway" (the
// draft stays on this device and is offered on the next visit) or "Stay".
//
// Needs a data router (createBrowserRouter / createMemoryRouter) for useBlocker; under a plain
// <MemoryRouter> or no router it renders nothing.
import { useCallback, useContext, useId, useRef, useState } from 'react';
import { type BlockerFunction, UNSAFE_DataRouterContext, useBlocker, useNavigate } from 'react-router';
import { Button, Dialog } from '@/ui';
import styles from './save.module.css';
import type { AutosaveStatus } from './autosave';
import type { UseAutosaveResult } from './useAutosave';

export interface LeaveGuardProps {
  autosave: UseAutosaveResult;
}

export function LeaveGuard({ autosave }: LeaveGuardProps) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  return dataRouter ? <BlockingLeaveGuard autosave={autosave} /> : null;
}

function reasonOf(status: AutosaveStatus): string {
  switch (status) {
    case 'conflict':
      return 'Your latest changes are not saved: this brew was saved again somewhere else. If you leave, they stay on this device and are offered the next time you open the brew.';
    case 'lost':
      return 'Your latest changes are not saved, and this brew can’t be saved any more. Save them as a new brew to keep them.';
    case 'offline':
      return 'You are offline and your latest changes are not saved yet. If you leave, they stay on this device and are offered the next time you open the brew.';
    case 'signedOut':
      return 'Your latest changes are not saved: sign in to save them. If you leave, they stay on this device until then.';
    case 'saving':
      return 'Your latest changes are still being saved and the server hasn’t answered yet. If you leave, they stay on this device.';
    default:
      return 'Your latest changes couldn’t be saved. If you leave, they stay on this device and are offered the next time you open the brew.';
  }
}

function BlockingLeaveGuard({ autosave }: LeaveGuardProps) {
  const { controller } = autosave;
  const navigate = useNavigate();
  const stayRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname && controller.shouldWarnOnUnload('app'),
    [controller],
  );
  const blocker = useBlocker(shouldBlock);
  const blocked = blocker.state === 'blocked';
  const [copying, setCopying] = useState(false);
  // A lost brew's copy shows as 'saving' while it runs.
  const status = copying && autosave.status === 'saving' ? 'lost' : autosave.status;
  const canCopy = status === 'conflict' || status === 'lost';

  const stay = () => {
    if (blocker.state === 'blocked') blocker.reset();
  };
  const leave = () => {
    if (blocker.state === 'blocked') blocker.proceed();
  };
  const saveCopy = async () => {
    if (blocker.state !== 'blocked') return;
    const target = blocker.location;
    const to = { pathname: target.pathname, search: target.search, hash: target.hash };
    const state: unknown = target.state;
    setCopying(true);
    const outcome = await controller.saveAsCopy();
    setCopying(false);
    if (outcome !== 'saved') return; // the reason shows in the status or the conflict
    // Saved: nothing holds the navigation any more. The copy's own navigation (onCreated) may
    // already have released this blocker, so go on with a navigation of our own.
    void navigate(to, { state });
  };

  return (
    <Dialog
      open={blocked}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
      role="alertdialog"
      size="sm"
      title="Leave without saving?"
      description={reasonOf(status)}
      closeOnOverlayClick={false}
      initialFocusRef={stayRef}
      data-testid="leave-guard"
      footer={
        <>
          <Button ref={stayRef} onClick={stay} data-testid="leave-stay">
            Stay
          </Button>
          <Button variant="danger" onClick={leave} data-testid="leave-anyway">
            Leave anyway
          </Button>
        </>
      }
    >
      {canCopy ? (
        <div className={styles.option}>
          <Button
            variant="primary"
            loading={copying || autosave.conflict?.busy === 'copy'}
            onClick={() => void saveCopy()}
            aria-describedby={hintId}
            data-testid="leave-copy"
          >
            Save mine as a copy
          </Button>
          <p id={hintId} className={styles.optionHint}>
            Saves your version as a new brew, then leaves.
          </p>
        </div>
      ) : null}
      {autosave.conflict?.actionError ? (
        <p className={styles.actionError} role="alert">
          {autosave.conflict.actionError}
        </p>
      ) : null}
    </Dialog>
  );
}
