// The confirmation for an admin action (lock, unlock, dismiss a review, delete a notification).
// Like the UI kit's ConfirmDialog (an alertdialog; Cancel first for danger), but it closes after the
// request either way and decides where focus goes: after a success, `focusAfter()` (when the
// action removes the button that opened it, e.g. a table row), else back to that button. After a
// failure, `onError` runs once the dialog has closed and returned focus, so it may move focus
// itself (e.g. to a form field the API rejected).
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@/ui';

export interface ConfirmRequest {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  tone?: 'default' | 'danger';
  /** The request; the dialog stays open and busy until it settles. */
  run: () => Promise<unknown>;
  /** After a success: where focus goes instead of the opener (called after the request). */
  focusAfter?: () => HTMLElement | null;
  /** After a failure (the dialog has closed and focus is back on the opener). */
  onError?: (error: unknown) => void;
  'data-testid'?: string;
}

export interface ConfirmActionDialogProps {
  request: ConfirmRequest;
  open: boolean;
  onClose: () => void;
}

export function ConfirmActionDialog({ request, open, onClose }: ConfirmActionDialogProps) {
  const [pending, setPending] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const failure = useRef<{ error: unknown; onError?: (error: unknown) => void } | null>(null);
  const danger = request.tone === 'danger';

  // The Dialog returns focus in a layout-effect cleanup when it closes; this passive effect runs
  // after that, so the error handler has the last word on focus.
  useEffect(() => {
    if (open || !failure.current) return;
    const { error, onError } = failure.current;
    failure.current = null;
    onError?.(error);
  }, [open]);

  const cancel = () => {
    if (pending) return;
    returnRef.current = null;
    onClose();
  };

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    try {
      await request.run();
      returnRef.current = request.focusAfter?.() ?? null;
    } catch (error) {
      failure.current = { error, onError: request.onError };
      returnRef.current = null;
    }
    setPending(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
      title={request.title}
      description={request.message}
      role="alertdialog"
      size="sm"
      closeOnEscape={!pending}
      closeOnOverlayClick={false}
      showCloseButton={false}
      initialFocusRef={danger ? cancelRef : confirmRef}
      returnFocusRef={returnRef}
      data-testid={request['data-testid'] ?? 'admin-confirm'}
      footer={
        <>
          <Button ref={cancelRef} onClick={cancel} aria-disabled={pending || undefined} data-testid="admin-confirm-cancel">
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={danger ? 'danger' : 'primary'}
            loading={pending}
            onClick={() => void confirm()}
            data-testid="admin-confirm-ok"
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    />
  );
}
