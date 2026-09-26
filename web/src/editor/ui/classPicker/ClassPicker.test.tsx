// ClassPicker: chips, the searchable combobox, keyboard operation, validation, apply and remove.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ClassPicker, type ClassPickerProps } from './ClassPicker';
import type { ThemeClass } from './themeClasses';

const suggestions: ThemeClass[] = [
  { name: 'monster', rules: 30, block: true, inline: false },
  { name: 'note', rules: 10, block: true, inline: false },
  { name: 'descriptive', rules: 8, block: true, inline: false },
  { name: 'wide', rules: 12, block: false, inline: false },
  { name: 'frame', rules: 6, block: false, inline: false },
];

function setup(props: Partial<ClassPickerProps> = {}) {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  render(<ClassPicker open mode="themeBlock" suggestions={suggestions} onApply={onApply} onOpenChange={onOpenChange} data-testid="picker" {...props} />);
  const input = screen.getByRole('combobox', { name: 'Add a class' });
  return { user, onApply, onOpenChange, input };
}

const optionNames = () => within(screen.getByRole('listbox', { name: 'Theme classes' })).queryAllByRole('option').map((o) => o.textContent?.replace(/on (spans|blocks)$/, ''));

describe('ClassPicker', () => {
  it('opens as a labelled dialog with the field focused and every suggestion listed', () => {
    const { input } = setup();
    expect(screen.getByRole('dialog', { name: 'Wrap in a theme block' })).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(optionNames()).toEqual(['monster', 'note', 'descriptive', 'wide', 'frame']);
    expect(screen.getByRole('status')).toHaveTextContent('5 theme classes');
  });

  it('filters while typing; arrows move the active option; Enter adds it; Enter again applies', async () => {
    const { user, input, onApply, onOpenChange } = setup();
    await user.type(input, 'r');
    expect(optionNames()).toEqual(['monster', 'descriptive', 'frame']);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const active = screen.getByRole('option', { selected: true });
    expect(active).toHaveTextContent('descriptive');
    expect(input).toHaveAttribute('aria-activedescendant', active.id);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('frame'); // wraps
    await user.keyboard('{Enter}');
    expect(within(screen.getByTestId('picker-chosen')).getByText('frame')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(optionNames()).not.toContain('frame');
    await user.keyboard('{Enter}');
    expect(onApply).toHaveBeenCalledWith(['frame']);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('adds typed classes with Space, comma or Enter, and pending text on apply', async () => {
    const { user, input, onApply } = setup();
    await user.type(input, 'myClass ');
    await user.type(input, 'other,');
    await user.type(input, 'third{Enter}');
    expect(within(screen.getByTestId('picker-chosen')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['myClass', 'other', 'third']);
    await user.type(input, 'last');
    await user.click(screen.getByRole('button', { name: 'Wrap' }));
    expect(onApply).toHaveBeenCalledWith(['myClass', 'other', 'third', 'last']);
  });

  it('refuses reserved classes with a message on the field', async () => {
    const { user, input, onApply } = setup();
    await user.type(input, 'page{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('“page” is reserved by the editor')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Wrap' }));
    expect(onApply).not.toHaveBeenCalled();
    await user.clear(input);
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('Backspace on an empty field removes the last class; chip buttons remove one', async () => {
    const { user, input, onApply } = setup({ mode: 'span', initialClasses: ['a', 'b', 'c'], editing: true });
    expect(screen.getByRole('dialog', { name: 'Edit the span’s classes' })).toBeInTheDocument();
    await user.keyboard('{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Remove class a' }));
    expect(input).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Save classes' }));
    expect(onApply).toHaveBeenCalledWith(['b']);
  });

  it('a click on an option adds it and keeps the focus in the field', async () => {
    const { user, input, onApply } = setup({ mode: 'span' });
    await user.click(screen.getByRole('option', { name: 'wide' }));
    expect(input).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onApply).toHaveBeenCalledWith(['wide']);
  });

  it('offers the remove action and closes on Escape without applying', async () => {
    const onRemove = vi.fn();
    const { user, onApply, onOpenChange } = setup({ onRemove, removeLabel: 'Unwrap “note”' });
    await user.click(screen.getByRole('button', { name: 'Unwrap “note”' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('says so when nothing matches, and Enter still adds the typed class', async () => {
    const { user, input } = setup();
    await user.type(input, 'zzz');
    expect(screen.getByText('No theme class matches “zzz”. Enter adds it anyway.')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(within(screen.getByTestId('picker-chosen')).getByText('zzz')).toBeInTheDocument();
  });
});
