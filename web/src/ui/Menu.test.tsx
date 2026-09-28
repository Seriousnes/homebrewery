import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, Menu, MenuButton } from './Menu';
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

  it('renders custom content in place of the label; the label stays the name and the typeahead text', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(id: string) => void>();
    render(
      <MenuButton
        label="Style"
        items={[
          { id: 'plain', label: 'Plain', onSelect: () => onSelect('plain') },
          { id: 'title', label: 'Title', content: <h1 data-testid="title-preview">Big title</h1>, onSelect: () => onSelect('title') },
        ]}
      />,
    );
    screen.getByRole('button', { name: 'Style' }).focus();
    await user.keyboard('{ArrowDown}');
    const plain = await screen.findByRole('menuitem', { name: 'Plain' });
    expect(plain).not.toHaveAttribute('aria-label');
    const title = screen.getByRole('menuitem', { name: 'Title' });
    expect(title).toHaveAttribute('aria-label', 'Title');
    expect(title).toContainElement(screen.getByTestId('title-preview'));
    expect(title).not.toHaveTextContent('Title');
    await user.keyboard('t');
    expect(title).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('title');
  });
});

const nestedItems = (onSelect: (id: string) => void): MenuEntry[] => [
  { id: 'cut', label: 'Cut', onSelect: () => onSelect('cut') },
  {
    id: 'format',
    type: 'submenu',
    label: 'Format',
    items: [
      { id: 'bold', label: 'Bold', onSelect: () => onSelect('bold') },
      { id: 'italic', label: 'Italic', onSelect: () => onSelect('italic') },
    ],
  },
  { id: 'off', type: 'submenu', label: 'Off', disabled: true, items: [{ id: 'x', label: 'X', onSelect: () => onSelect('x') }] },
  { id: 'paste', label: 'Paste', onSelect: () => onSelect('paste') },
];

describe('submenus', () => {
  it('ArrowRight, Enter or a click open a submenu on its first item; ArrowLeft and Escape go back to its item', async () => {
    const user = userEvent.setup();
    render(<MenuButton label="Edit" items={nestedItems(vi.fn())} />);
    screen.getByRole('button', { name: 'Edit' }).focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const format = screen.getByRole('menuitem', { name: 'Format' });
    expect(format).toHaveFocus();
    expect(format).toHaveAttribute('aria-haspopup', 'menu');
    expect(format).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{ArrowRight}');
    const sub = await screen.findByRole('menu', { name: 'Format' });
    expect(format).toHaveAttribute('aria-expanded', 'true');
    expect(format).toHaveAttribute('aria-controls', sub.id);
    expect(screen.getByRole('menuitem', { name: 'Bold' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Italic' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('menu', { name: 'Format' })).toBeNull();
    expect(format).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: 'Bold' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Format' })).toBeNull();
    expect(format).toHaveFocus();
    expect(screen.getByRole('menu', { name: 'Edit' })).toBeInTheDocument();
    await user.click(format);
    expect(await screen.findByRole('menu', { name: 'Format' })).toBeInTheDocument();
  });

  it('picking an item of a submenu closes every menu and refocuses the trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<MenuButton label="Edit" items={nestedItems(onSelect)} />);
    const trigger = screen.getByRole('button', { name: 'Edit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('bold');
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    expect(trigger).toHaveFocus();
  });

  it('the pointer on a submenu item opens it without taking the focus; on another item closes it; disabled ones stay shut', async () => {
    const user = userEvent.setup();
    render(<MenuButton label="Edit" items={nestedItems(vi.fn())} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.hover(screen.getByRole('menuitem', { name: 'Format' }));
    expect(await screen.findByRole('menu', { name: 'Format' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Format' })).toHaveFocus();
    await user.hover(screen.getByRole('menuitem', { name: 'Paste' }));
    expect(screen.queryByRole('menu', { name: 'Format' })).toBeNull();
    await user.hover(screen.getByRole('menuitem', { name: 'Off' }));
    await user.click(screen.getByRole('menuitem', { name: 'Off' }));
    expect(screen.queryByRole('menu', { name: 'Off' })).toBeNull();
  });

  it('Tab in a submenu closes every menu', async () => {
    const user = userEvent.setup();
    render(<MenuButton label="Edit" items={nestedItems(vi.fn())} />);
    const trigger = screen.getByRole('button', { name: 'Edit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}{Tab}');
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    expect(trigger).toHaveFocus();
  });
});

describe('ContextMenu', () => {
  function Host({ onClose, onSelect = vi.fn() }: { onClose: (returnFocus: boolean) => void; onSelect?: (id: string) => void }) {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button">Outside</button>
        {open ? (
          <ContextMenu
            items={nestedItems(onSelect)}
            point={{ x: 120, y: 80 }}
            label="Editing"
            footer="Shift+right-click: browser menu"
            onClose={(returnFocus) => {
              setOpen(false);
              onClose(returnFocus);
            }}
            data-testid="ctx"
          />
        ) : null}
      </>
    );
  }

  it('opens at the point with the focus on its first item, named, described by its footer', async () => {
    render(<Host onClose={vi.fn()} />);
    const menu = await screen.findByRole('menu', { name: 'Editing' });
    expect(menu).toHaveAccessibleDescription('Shift+right-click: browser menu');
    expect(menu.style.top).toBe('80px');
    expect(menu.style.left).toBe('120px');
    expect(screen.getByRole('menuitem', { name: 'Cut' })).toHaveFocus();
    // No browser menu over it.
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    screen.getByRole('menuitem', { name: 'Cut' }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('picking an item or Escape asks for the focus back; a click outside does not', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const { unmount } = render(<Host onClose={onClose} onSelect={onSelect} />);
    await screen.findByRole('menu');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('cut');
    expect(onClose).toHaveBeenLastCalledWith(true);
    unmount();

    render(<Host onClose={onClose} />);
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a click outside closes it without asking for the focus back', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    await screen.findByRole('menu');
    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(onClose).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('submenus work in it too; picking in one closes it with the focus asked back', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();
    render(<Host onClose={onClose} onSelect={onSelect} />);
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('italic');
    expect(onClose).toHaveBeenCalledWith(true);
    expect(screen.queryAllByRole('menu')).toHaveLength(0);
  });
});
