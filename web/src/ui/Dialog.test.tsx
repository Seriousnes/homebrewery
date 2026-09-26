import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { TextField } from './TextField';

function DialogHarness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const change = (next: boolean) => {
    onOpenChange?.(next);
    setOpen(next);
  };
  return (
    <div data-testid="app">
      <Button onClick={() => setOpen(true)}>Open settings</Button>
      <Dialog
        open={open}
        onOpenChange={change}
        title="Brew settings"
        description="Title and theme."
        footer={
          <>
            <Button onClick={() => change(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setConfirm(true)}>
              Delete
            </Button>
          </>
        }
      >
        <TextField label="Title" />
        <TextField label="Description" />
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete brew?"
        message="This cannot be undone."
        tone="danger"
        confirmLabel="Delete"
        onConfirm={() => undefined}
      />
    </div>
  );
}

describe('Dialog', () => {
  it('is a labelled modal dialog that focuses its first field and makes the page inert', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Brew settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Title and theme.');
    expect(screen.getByLabelText('Title')).toHaveFocus();
    expect(screen.getByTestId('app').closest('[inert]')).not.toBeNull();
  });

  it('keeps Tab inside and wraps both ways', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByRole('dialog');
    const dialog = screen.getByRole('dialog');
    const title = screen.getByLabelText('Title');
    await user.tab();
    expect(screen.getByLabelText('Description')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    const del = screen.getAllByRole('button', { name: 'Delete' })[0]!;
    expect(del).toHaveFocus();
    await user.tab();
    // Wraps to the first tabbable element: the close button in the header.
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(del).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(title).not.toHaveFocus();
  });

  it('closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<DialogHarness onOpenChange={onOpenChange} />);
    const opener = screen.getByRole('button', { name: 'Open settings' });
    await user.click(opener);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(screen.getByTestId('app').closest('[inert]')).toBeNull();
  });

  it('closes from the close button and on an overlay click, not a click inside', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(dialog);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(dialog.parentElement!);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('brings focus back when something outside takes it', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByRole('dialog');
    act(() => screen.getByRole('button', { name: 'Open settings', hidden: true }).focus());
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
});

describe('ConfirmDialog', () => {
  it('nests over a dialog, focuses Cancel for danger, and Escape closes only itself', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole('button', { name: 'Open settings' }));
    await screen.findByRole('dialog');
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    await user.click(deleteButton);
    const alert = await screen.findByRole('alertdialog', { name: 'Delete brew?' });
    expect(alert).toHaveAccessibleDescription('This cannot be undone.');
    expect(within(alert).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(deleteButton).toHaveFocus();
  });

  it('waits for an async confirm, then closes; stays open when it fails', async () => {
    const user = userEvent.setup();
    let resolve: () => void = () => undefined;
    let reject: (e: Error) => void = () => undefined;
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Publish?"
        onConfirm={() =>
          new Promise<void>((res) => {
            resolve = res;
          })
        }
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    onOpenChange.mockClear();
    rerender(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Publish?"
        onConfirm={() =>
          new Promise<void>((_res, rej) => {
            reject = rej;
          })
        }
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await act(async () => {
      reject(new Error('nope'));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).not.toHaveAttribute('aria-busy'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
