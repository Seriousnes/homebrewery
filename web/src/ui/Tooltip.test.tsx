import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconButton } from './IconButton';
import { Tooltip } from './Tooltip';

afterEach(() => {
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('shows after the hover delay, hides on leave and Escape', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Save now" shortcut="Ctrl+S" delay={300}>
        <button type="button">Save</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAccessibleDescription('Save now (Ctrl+S)');
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Save nowCtrl+S');
    fireEvent.pointerLeave(button);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // Warm: a second hover right after shows at once.
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('stays while the pointer moves onto the tooltip; ignores touch; hides on press', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Info" delay={0}>
        <button type="button">i</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'i' });
    fireEvent.pointerEnter(button, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tip = screen.getByRole('tooltip');
    fireEvent.pointerLeave(button);
    fireEvent.pointerEnter(tip);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerDown(button);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('does nothing when disabled', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Nope" delay={0} disabled>
        <button type="button">x</button>
      </Tooltip>,
    );
    fireEvent.pointerEnter(screen.getByRole('button'), { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('IconButton: the label names the button and the tooltip does not repeat it as a description', () => {
    vi.useFakeTimers();
    render(<IconButton icon="bold" label="Bold" shortcut="Ctrl+B" aria-keyshortcuts="Control+B" />);
    const button = screen.getByRole('button', { name: 'Bold' });
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+B');
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('BoldCtrl+B');
  });
});
