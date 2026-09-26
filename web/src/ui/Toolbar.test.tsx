import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { IconButton } from './IconButton';
import { MenuButton } from './Menu';
import { Toolbar, ToolbarGroup, ToolbarSeparator } from './Toolbar';

function Harness({ undoDisabled = false }: { undoDisabled?: boolean }) {
  const [bold, setBold] = useState(false);
  return (
    <>
      <button type="button">Before</button>
      <Toolbar label="Formatting">
        <ToolbarGroup label="History">
          <IconButton icon="undo" label="Undo" disabled={undoDisabled} />
          <IconButton icon="redo" label="Redo" />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Marks">
          <IconButton icon="bold" label="Bold" pressed={bold} onClick={() => setBold(!bold)} />
          <IconButton icon="italic" label="Italic" />
          <input aria-label="Font size" defaultValue="12" />
          <MenuButton label="Insert" items={[{ id: 'table', label: 'Table', onSelect: () => undefined }]} />
        </ToolbarGroup>
      </Toolbar>
      <button type="button">After</button>
    </>
  );
}

describe('Toolbar', () => {
  it('has role toolbar, groups and a separator, and is a single tab stop', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.getByRole('group', { name: 'Marks' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('arrow keys, Home and End move focus; Tab returns to the last used item', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Insert' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Insert' })).toHaveFocus();
    await user.keyboard('{Home}{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveFocus();
  });

  it('lets a text input keep its arrow keys; menus open with ArrowDown', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Font size' });
    await user.click(input);
    await user.keyboard('{ArrowLeft}');
    expect(input).toHaveFocus();
    screen.getByRole('button', { name: 'Insert' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('menuitem', { name: 'Table' })).toHaveFocus();
    // Keys inside the (portaled) menu don't move toolbar focus.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('menuitem', { name: 'Table' })).toHaveFocus();
  });

  it('skips disabled items and keeps a tab stop when the active item gets disabled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness />);
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    screen.getByRole('button', { name: 'Before' }).focus();
    rerender(<Harness undoDisabled />);
    await new Promise((resolve) => setTimeout(resolve, 0)); // MutationObserver
    await user.tab();
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Insert' })).toHaveFocus();
  });

  it('vertical toolbars use Up/Down and ignore Left/Right', async () => {
    const user = userEvent.setup();
    render(
      <Toolbar label="Tools" orientation="vertical">
        <IconButton icon="insert" label="Insert" tooltip={false} />
        <IconButton icon="table" label="Table" tooltip={false} />
      </Toolbar>,
    );
    expect(screen.getByRole('toolbar')).toHaveAttribute('aria-orientation', 'vertical');
    screen.getByRole('button', { name: 'Insert' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Insert' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Table' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('button', { name: 'Insert' })).toHaveFocus();
  });
});
