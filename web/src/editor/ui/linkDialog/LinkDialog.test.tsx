// LinkDialog: address validation and normalization, link text, remove.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LinkDialog, type LinkDialogProps } from './LinkDialog';

function setup(props: Partial<LinkDialogProps> = {}) {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(<LinkDialog open onApply={onApply} onOpenChange={onOpenChange} {...props} />);
  return { user, onApply, onOpenChange, href: screen.getByRole('textbox', { name: 'Address' }) };
}

describe('LinkDialog', () => {
  it('adds https:// to a bare domain and applies on Enter', async () => {
    const { user, href, onApply, onOpenChange } = setup();
    expect(screen.getByRole('dialog', { name: 'Add a link' })).toBeInTheDocument();
    expect(href).toHaveFocus();
    await user.type(href, 'example.com/rules{Enter}');
    expect(onApply).toHaveBeenCalledWith('https://example.com/rules', undefined);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('refuses addresses outside the URL policy and empty ones', async () => {
    const { user, href, onApply } = setup();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Enter an address')).toBeInTheDocument();
    await user.type(href, 'javascript:alert(1){Enter}');
    expect(href).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Use an http, https or mailto address/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('asks for the text when nothing is selected', async () => {
    const { user, href, onApply } = setup({ askText: true });
    await user.type(href, '#p3');
    await user.type(screen.getByRole('textbox', { name: 'Text' }), 'page three');
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    expect(onApply).toHaveBeenCalledWith('#p3', 'page three');
  });

  it('edits an existing link and can remove it', async () => {
    const onRemove = vi.fn();
    const { user, href } = setup({ editing: true, initialHref: 'https://a.example', onRemove });
    expect(screen.getByRole('dialog', { name: 'Edit link' })).toBeInTheDocument();
    expect(href).toHaveValue('https://a.example');
    expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
