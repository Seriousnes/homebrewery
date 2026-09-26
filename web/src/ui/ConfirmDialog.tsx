import { type ReactNode, useRef, useState } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** The question or consequence (the dialog's description). */
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' styles the confirm button red and focuses Cancel first. */
  tone?: 'default' | 'danger';
  /**
   * Runs on confirm. A returned promise keeps the dialog open and busy until it settles: it
   * closes on success and stays open on failure (report the error elsewhere, e.g. a toast).
   */
  onConfirm: () => void | Promise<unknown>;
  onCancel?: () => void;
  children?: ReactNode;
}

/** A yes/no alertdialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const cancel = () => {
    if (pending) return;
    onCancel?.();
    onOpenChange(false);
  };
  const confirm = async () => {
    if (pending) return;
    const result = onConfirm();
    if (!(result instanceof Promise)) {
      onOpenChange(false);
      return;
    }
    setPending(true);
    try {
      await result;
      onOpenChange(false);
    } catch {
      // Stays open; the caller reports the failure.
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : cancel())}
      title={title}
      description={message}
      role="alertdialog"
      size="sm"
      closeOnEscape={!pending}
      closeOnOverlayClick={false}
      showCloseButton={false}
      initialFocusRef={tone === 'danger' ? cancelRef : confirmRef}
      footer={
        <>
          <Button ref={cancelRef} onClick={cancel} aria-disabled={pending || undefined}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} variant={tone === 'danger' ? 'danger' : 'primary'} loading={pending} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
