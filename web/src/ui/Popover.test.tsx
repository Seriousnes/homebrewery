import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Popover } from './Popover';
import { TextField } from './TextField';

function Harness({ trapFocus = false }: { trapFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={anchor} aria-expanded={open} aria-controls="link-popover" aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        Link
      </Button>
      <button type="button">Elsewhere</button>
      <Popover
        id="link-popover"
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchor}
        aria-label="Edit link"
        trapFocus={trapFocus}
      >
        <TextField label="URL" />
        <Button>Apply</Button>
      </Popover>
    </>
  );
}

describe('Popover', () => {
  it('opens as a named non-modal dialog, focuses its first field, and Escape returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Link' });
    await user.click(trigger);
    const popover = await screen.findByRole('dialog', { name: 'Edit link' });
    expect(popover).not.toHaveAttribute('aria-modal');
    expect(popover.style.top).toMatch(/px$/);
    expect(screen.getByRole('textbox', { name: 'URL' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on an outside press and when focus leaves; the trigger toggles it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Link' });
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(trigger);
    await screen.findByRole('dialog');
    // Shift+Tab at the start goes back to the trigger, closing the popover.
    await user.tab({ shift: true });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Tab at the end continues after the trigger in the page.
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Focus moved away by other means (a click, a script) also closes it.
    await user.click(trigger);
    await screen.findByRole('dialog');
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('can trap Tab inside', async () => {
    const user = userEvent.setup();
    render(<Harness trapFocus />);
    await user.click(screen.getByRole('button', { name: 'Link' }));
    await screen.findByRole('dialog');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'URL' })).toHaveFocus();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
