import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Menu, MenuButton } from './Menu';
import type { MenuEntry } from './menuTypes';

function Harness({ onSelect = vi.fn(), disabledTable = false }: { onSelect?: (id: string) => void; disabledTable?: boolean }) {
  const [wide, setWide] = useState(false);
  const [align, setAlign] = useState('left');
  const items: MenuEntry[] = [
    { id: 'paragraph', label: 'Paragraph', icon: 'paragraph', onSelect: () => onSelect('paragraph') },
    { id: 'h1', label: 'Heading 1', shortcut: 'Ctrl+Shift+1', onSelect: () => onSelect('h1') },
    { id: 'h2', label: 'Heading 2', onSelect: () => onSelect('h2') },
    { type: 'separator' },
    { id: 'table', label: 'Table', disabled: disabledTable, onSelect: () => onSelect('table') },
    { id: 'wide', type: 'checkbox', label: 'Wide', checked: wide, onCheckedChange: setWide, closeOnSelect: false },
    {
      type: 'group',
      id: 'align',
      label: 'Alignment',
      items: [
        { id: 'left', type: 'radio', label: 'Left', checked: align === 'left', onSelect: () => setAlign('left') },
        { id: 'right', type: 'radio', label: 'Right', checked: align === 'right', onSelect: () => setAlign('right') },
      ],
    },
  ];
  return (
    <>
      <MenuButton label="Insert" items={items} data-testid="insert" />
      <button type="button">After</button>
    </>
  );
}

describe('Menu', () => {
  it('opens from the keyboard on the first item and navigates with arrows, Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Insert' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    const menu = await screen.findByRole('menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', menu.id);
    expect(menu).toHaveAttribute('aria-labelledby', trigger.id);
    expect(screen.getByRole('menuitem', { name: 'Paragraph' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Heading 1/ })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('menuitemradio', { name: 'Right' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Paragraph' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitemradio', { name: 'Right' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Paragraph' })).toHaveFocus();
    // Roving tabindex: only the focused item is a tab stop.
    expect(screen.getAllByRole('menuitem').filter((el) => el.tabIndex === 0)).toHaveLength(1);
  });

  it('ArrowUp opens on the last item', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('button', { name: 'Insert' }).focus();
    await user.keyboard('{ArrowUp}');
    expect(await screen.findByRole('menuitemradio', { name: 'Right' })).toHaveFocus();
  });

  it('typeahead jumps to matching items and skips disabled ones', async () => {
    const user = userEvent.setup();
    render(<Harness disabledTable />);
    screen.getByRole('button', { name: 'Insert' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('h');
    expect(screen.getByRole('menuitem', { name: /Heading 1/ })).toHaveFocus();
    await user.keyboard('h');
    expect(screen.getByRole('menuitem', { name: 'Heading 2' })).toHaveFocus();
    await user.keyboard('t');
    // Table is disabled: no match, focus stays.
    expect(screen.getByRole('menuitem', { name: 'Heading 2' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Table' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('Enter activates an item, closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const trigger = screen.getByRole('button', { name: 'Insert' });
    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('h1');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('checkbox items toggle and can keep the menu open; radio items check', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    const wide = await screen.findByRole('menuitemcheckbox', { name: 'Wide' });
    expect(wide).toHaveAttribute('aria-checked', 'false');
    await user.click(wide);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Wide' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Alignment' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitemradio', { name: 'Right' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Right' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Left' })).toHaveAttribute('aria-checked', 'false');
  });

  it('Escape and Tab close and refocus the trigger; an outside click closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Insert' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    await screen.findByRole('menu');
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await screen.findByRole('menu');
    await user.click(screen.getByRole('button', { name: 'After' }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('clicking the trigger toggles; hovering moves focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Insert' });
    await user.click(trigger);
    await screen.findByRole('menu');
    await user.hover(screen.getByRole('menuitem', { name: 'Heading 2' }));
    expect(screen.getByRole('menuitem', { name: 'Heading 2' })).toHaveFocus();
    await user.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('supports a custom trigger and a menu label', async () => {
    const user = userEvent.setup();
    render(
      <Menu
        label="Zoom levels"
        items={[{ id: 'a', label: 'Fit', onSelect: () => undefined }]}
        trigger={(props) => (
          <button type="button" {...props}>
            100%
          </button>
        )}
      />,
    );
    await user.click(screen.getByRole('button', { name: '100%' }));
    expect(await screen.findByRole('menu', { name: 'Zoom levels' })).toBeInTheDocument();
  });
});
