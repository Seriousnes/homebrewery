// Combobox and TagInput behaviour in jsdom (keyboard, ARIA wiring, focus). Layout and the portal
// in a real modal dialog are covered by web/e2e/panels.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Combobox } from './Combobox';
import type { ComboboxOption } from './comboboxModel';
import { normalizeTag, TAG_PATTERN, tagProblem, tagType } from './normalizeTag';
import { TagInput } from './TagInput';

const OPTIONS: ComboboxOption[] = [
  { value: 'en', label: 'en', detail: 'English' },
  { value: 'de', label: 'de', detail: 'Deutsch', keywords: ['German'] },
  { value: 'fr', label: 'fr', detail: 'français', disabled: true },
  { value: 'ja', label: 'ja', detail: '日本語', group: 'Asia' },
];

function ControlledCombobox(props: { onSelect?: (o: ComboboxOption) => void; onCommit?: (t: string) => void; initial?: string }) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <Combobox
      label="Language"
      value={value}
      onValueChange={setValue}
      options={OPTIONS}
      currentValue="de"
      onSelect={(o) => {
        setValue(o.value);
        props.onSelect?.(o);
      }}
      {...(props.onCommit ? { onCommit: props.onCommit } : {})}
    />
  );
}

describe('Combobox', () => {
  it('is a labelled combobox that controls a listbox', () => {
    render(<ControlledCombobox />);
    const input = screen.getByRole('combobox', { name: 'Language' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    // The list exists only while open (see Combobox.tsx), and so does aria-controls.
    expect(input).not.toHaveAttribute('aria-controls');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('points aria-controls at the open listbox', async () => {
    const user = userEvent.setup();
    render(<ControlledCombobox />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowDown}');
    const listId = input.getAttribute('aria-controls');
    expect(listId).toBeTruthy();
    expect(document.getElementById(listId!)).toBe(screen.getByRole('listbox', { name: 'Language' }));
  });

  it('ArrowDown opens and highlights; Enter picks; disabled options are skipped', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledCombobox onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.dataset.value)).toEqual(['en', 'de', 'fr', 'ja']);
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    // fr is disabled: skipped.
    expect(input.getAttribute('aria-activedescendant')).toBe(options[3]!.id);
    // The group heading names the group.
    expect(within(list).getByRole('group', { name: 'Asia' })).toContainElement(options[3]!);
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: 'ja' }));
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveValue('ja');
    expect(input).toHaveFocus();
  });

  it('ArrowUp opens on the last option and wraps', async () => {
    const user = userEvent.setup();
    render(<ControlledCombobox />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowUp}');
    const options = screen.getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[3]!.id);
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
  });

  it('typing filters; Enter without a highlight commits the text', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<ControlledCombobox onCommit={onCommit} />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'germ');
    expect(screen.getAllByRole('option').map((o) => o.dataset.value)).toEqual(['de']);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith('germ');
  });

  it('shows the empty message when nothing matches', async () => {
    const user = userEvent.setup();
    render(<ControlledCombobox />);
    await user.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole('listbox')).toHaveTextContent('No matches');
  });

  it('Escape closes the list and is not passed on', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    render(<ControlledCombobox />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Escape}');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(outer.mock.calls.some(([e]) => (e as KeyboardEvent).key === 'Escape' && !(e as KeyboardEvent).defaultPrevented)).toBe(false);
    document.removeEventListener('keydown', outer);
  });

  it('the toggle opens the whole list even with text in the box, and marks the current option', async () => {
    const user = userEvent.setup();
    render(<ControlledCombobox initial="en" />);
    await user.click(screen.getByRole('button', { name: 'Show options' }));
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);
    expect(options[1]).toHaveTextContent('(current)');
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('clicking an option picks it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ControlledCombobox onSelect={onSelect} />);
    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{ArrowDown}');
    await user.click(screen.getAllByRole('option')[1]!);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: 'de' }));
  });

  it('wires hint and error to the input', () => {
    render(<Combobox label="Theme" value="" onValueChange={() => {}} options={[]} onSelect={() => {}} hint="Pick one" error="Bad theme" />);
    const input = screen.getByRole('combobox', { name: 'Theme' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Pick one Bad theme');
  });
});

const TAG_SUGGESTION_OPTIONS: ComboboxOption[] = ['system:D&D 5e', 'type:Adventure', 'Dragons'].map((t) => ({ value: t, label: t }));

function Tags({ initial = [] as string[], onChange = vi.fn<(v: string[]) => void>() }) {
  const [values, setValues] = useState(initial);
  return (
    <TagInput
      label="Tags"
      itemName="tag"
      values={values}
      onChange={(next) => {
        setValues(next);
        onChange(next);
      }}
      suggestions={TAG_SUGGESTION_OPTIONS}
      validate={(raw, list, { index, suggested }) => tagProblem(raw, list, { pattern: suggested ? null : TAG_PATTERN, ...(index === undefined ? {} : { ignoreIndex: index }) })}
      normalize={(raw) => normalizeTag(raw.trim())}
      toneOf={(tag) => tagType(tag) ?? undefined}
    />
  );
}

describe('TagInput', () => {
  it('adds typed tags on Enter, normalized, and clears the box', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(v: string[]) => void>();
    render(<Tags onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(input, 'system : dnd{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['system:D&D']);
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    const chip = screen.getByRole('button', { name: 'Edit tag system:D&D' });
    expect(chip.closest('li')).toHaveAttribute('data-tone', 'system');
  });

  it('adds a suggestion picked from the list, and leaves listed ones out of the suggestions', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(v: string[]) => void>();
    render(<Tags initial={['Dragons']} onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(input, 'typ');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['Dragons', 'type:Adventure']);
    await user.click(screen.getByRole('button', { name: 'Show options' }));
    expect(screen.getAllByRole('option').map((o) => o.dataset.value)).toEqual(['system:D&D 5e']);
  });

  it('shows why a tag was refused and keeps the text', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(v: string[]) => void>();
    render(<Tags initial={['D&D']} onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.type(input, 'bad;tag{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/letter or digit/);
    expect(input).toHaveValue('bad;tag');
    await user.clear(input);
    await user.type(input, 'dnd{Enter}');
    expect(input).toHaveAccessibleDescription(/already in the list/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a chip and moves focus to the next one, then to the box', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(v: string[]) => void>();
    render(<Tags initial={['one', 'two']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Remove tag one' }));
    expect(onChange).toHaveBeenLastCalledWith(['two']);
    await act(() => new Promise((r) => requestAnimationFrame(r)));
    expect(screen.getByRole('button', { name: 'Edit tag two' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Remove tag two' }));
    await act(() => new Promise((r) => requestAnimationFrame(r)));
    expect(screen.getByRole('combobox', { name: 'Tags' })).toHaveFocus();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('edits a chip in place: Enter saves, Escape cancels without reaching the dialog', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(v: string[]) => void>();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    render(<Tags initial={['one', 'two']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit tag one' }));
    const editor = screen.getByRole('textbox', { name: 'Edit tag one' });
    expect(editor).toHaveFocus();
    // Hold the refocus the Escape defers to the next frame, to reopen the edit before it runs.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb));
    await user.keyboard('{Escape}');
    expect(outer.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape' && !(e as KeyboardEvent).defaultPrevented)).toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: 'Edit tag one' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Edit tag one' }));
    raf.mockRestore();
    expect(frames.length).toBeGreaterThan(0);
    act(() => frames.forEach((cb) => cb(0)));
    // The stale refocus must not close the reopened edit.
    expect(screen.getByRole('textbox', { name: 'Edit tag one' })).toHaveFocus();
    await user.clear(screen.getByRole('textbox', { name: 'Edit tag one' }));
    await user.type(screen.getByRole('textbox', { name: 'Edit tag one' }), 'dnd{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['D&D', 'two']);
    await act(() => new Promise((r) => requestAnimationFrame(r)));
    expect(screen.getByRole('button', { name: 'Edit tag D&D' })).toHaveFocus();
    document.removeEventListener('keydown', outer);
  });

  it('refuses an edit that duplicates another chip, and drops it on blur', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(v: string[]) => void>();
    render(<Tags initial={['one', 'two']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit tag one' }));
    const editor = screen.getByRole('textbox', { name: 'Edit tag one' });
    await user.clear(editor);
    await user.type(editor, 'TWO{Enter}');
    expect(editor).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(/already/);
    fireEvent.blur(editor);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit tag one' })).toBeInTheDocument();
  });

  it('read-only shows the values without controls', () => {
    render(<TagInput label="Invited authors" values={['carol']} onChange={() => {}} readOnly />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('list', { name: 'Invited authors' })).toHaveTextContent('carol');
  });
});

describe('Combobox filtering', () => {
  it('lists every option while the text is the current value, and filters once the user types', async () => {
    const user = userEvent.setup();
    render(<ControlledCombobox initial="de" />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    await user.keyboard('{Escape}');
    await user.type(input, '{Backspace}e');
    expect(screen.getAllByRole('option').map((o) => o.dataset.value)).toEqual(['de']);
    await user.keyboard('{Escape}{ArrowDown}');
    // Still what the user typed.
    expect(screen.getAllByRole('option').map((o) => o.dataset.value)).toEqual(['de']);
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}');
    // After a pick the box shows the value again: all options.
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });
});
