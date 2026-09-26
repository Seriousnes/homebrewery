import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox, Switch } from './Checkbox';
import { Select } from './Select';
import { TextArea, TextField } from './TextField';

describe('TextField and TextArea', () => {
  it('labels the input and describes it with hint and error', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TextField label="Handle" hint="3-32 characters" error="Handle taken" required onChange={onChange} aria-describedby="extra" />);
    const input = screen.getByRole('textbox', { name: 'Handle' });
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/3-32 characters.*Handle taken/);
    expect(input.getAttribute('aria-describedby')).toMatch(/^extra /);
    await user.type(input, 'bob');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('can hide its label visually and take an explicit id', () => {
    render(<TextField label="Search" hideLabel id="q" />);
    const input = screen.getByRole('textbox', { name: 'Search' });
    expect(input.id).toBe('q');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('TextArea works the same way', () => {
    render(<TextArea label="Description" hint="Plain text" />);
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveAccessibleDescription('Plain text');
  });
});

describe('Select', () => {
  it('is a labelled native select with options and a placeholder', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        label="Theme"
        placeholder="Choose…"
        options={[
          { value: '5ePHB', label: '5e PHB' },
          { value: 'Blank', label: 'Blank', disabled: true },
        ]}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Theme' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose…', '5e PHB', 'Blank']);
    await user.selectOptions(select, '5ePHB');
    expect(onChange).toHaveBeenCalledWith('5ePHB');
    expect(screen.getByRole('option', { name: 'Blank' })).toBeDisabled();
  });
});

describe('Checkbox and Switch', () => {
  it('toggle by click and keyboard', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Checkbox label="Published" hint="Listed in the vault" />
        <Switch label="Page shadows" defaultChecked />
      </>,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Published' });
    expect(checkbox).toHaveAccessibleDescription('Listed in the vault');
    await user.click(screen.getByText('Published'));
    expect(checkbox).toBeChecked();
    const toggle = screen.getByRole('switch', { name: 'Page shadows' });
    expect(toggle).toBeChecked();
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle).not.toBeChecked();
  });
});
