import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Tabs, type TabItem } from './Tabs';

const items: TabItem[] = [
  { id: 'node', label: 'Node', content: <p>Node settings</p> },
  { id: 'page', label: 'Page', content: <p>Page settings</p> },
  { id: 'locked', label: 'Locked', content: <p>Never</p>, disabled: true },
  { id: 'doc', label: 'Document', content: <input aria-label="Doc field" /> },
];

describe('Tabs', () => {
  it('renders a labelled tablist with one tab stop and the selected panel', () => {
    render(<Tabs items={items} label="Inspector" />);
    expect(screen.getByRole('tablist', { name: 'Inspector' })).toHaveAttribute('aria-orientation', 'horizontal');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'Node' });
    expect(panel).toHaveTextContent('Node settings');
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
    expect(screen.queryByText('Page settings')).not.toBeInTheDocument();
  });

  it('arrow keys select the next enabled tab (wrapping), Home and End jump', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Tabs items={items} label="Inspector" onValueChange={onValueChange} />);
    await user.click(screen.getByRole('tab', { name: 'Node' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Page' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Page settings');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Document' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Node' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Document' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Node' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Document' })).toHaveFocus();
    expect(onValueChange).toHaveBeenLastCalledWith('doc');
    await user.tab();
    expect(screen.getByRole('tabpanel')).toHaveFocus();
  });

  it('manual activation moves focus only; Enter selects', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} label="Inspector" activation="manual" />);
    screen.getByRole('tab', { name: 'Node' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Page' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Node settings');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Page settings');
  });

  it('is controllable, supports vertical orientation and keeps panels mounted on request', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = render(<Tabs items={items} label="I" value="page" onValueChange={onValueChange} orientation="vertical" keepMounted />);
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Page settings');
    expect(screen.getByText('Node settings', { selector: 'p' }).closest('[role=tabpanel]')).toHaveAttribute('hidden');
    screen.getByRole('tab', { name: 'Page' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onValueChange).toHaveBeenCalledWith('doc');
    // Controlled: stays on page until the parent changes value.
    expect(screen.getByRole('tab', { name: 'Page' })).toHaveAttribute('aria-selected', 'true');
    rerender(<Tabs items={items} label="I" value="doc" onValueChange={onValueChange} orientation="vertical" keepMounted />);
    expect(screen.getByRole('tab', { name: 'Document' })).toHaveAttribute('aria-selected', 'true');
  });

  it('falls back to the first enabled tab for an unknown or disabled value', () => {
    render(<Tabs items={items} label="I" value="locked" />);
    expect(screen.getByRole('tab', { name: 'Node' })).toHaveAttribute('aria-selected', 'true');
  });
});
