import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Drawer, SplitMain, SplitPanel } from './SplitPanel';

function Harness({ side = 'left' as const }: { side?: 'left' | 'right' | 'bottom' }) {
  const [open, setOpen] = useState(true);
  const [size, setSize] = useState(240);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <SplitPanel data-testid="split">
      <Drawer
        side={side}
        open={open}
        onOpenChange={setOpen}
        title="Outline"
        size={size}
        onSizeChange={setSize}
        minSize={160}
        maxSize={480}
        resizeLabel="Resize outline"
        closeLabel="Close outline"
        returnFocusRef={toggle}
        data-testid="drawer"
      >
        <button type="button">Heading one</button>
      </Drawer>
      <SplitMain>
        <Button ref={toggle} onClick={() => setOpen(!open)} aria-expanded={open}>
          Toggle outline
        </Button>
        <output data-testid="size">{size}</output>
      </SplitMain>
    </SplitPanel>
  );
}

describe('Drawer and SplitPanel', () => {
  it('is a complementary landmark named by its title, sized by `size`', () => {
    render(<Harness />);
    const drawer = screen.getByRole('complementary', { name: 'Outline' });
    expect(drawer).toHaveStyle({ width: '240px' });
    expect(screen.getByRole('heading', { level: 2, name: 'Outline' })).toBeInTheDocument();
  });

  it('resizes with the keyboard through a separator (left panel: Right grows)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const handle = screen.getByRole('separator', { name: 'Resize outline' });
    expect(handle).toHaveAttribute('aria-valuenow', '240');
    expect(handle).toHaveAttribute('aria-valuemin', '160');
    expect(handle).toHaveAttribute('aria-valuemax', '480');
    expect(handle).toHaveAttribute('aria-controls', screen.getByTestId('drawer').id);
    handle.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('size')).toHaveTextContent('256');
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(screen.getByTestId('size')).toHaveTextContent('192');
    await user.keyboard('{Home}');
    expect(handle).toHaveAttribute('aria-valuenow', '160');
    await user.keyboard('{End}');
    expect(screen.getByTestId('size')).toHaveTextContent('480');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('size')).toHaveTextContent('480');
  });

  it('right and bottom panels grow the other way', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness side="right" />);
    screen.getByRole('separator').focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByTestId('size')).toHaveTextContent('256');
    unmount();
    render(<Harness side="bottom" />);
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    handle.focus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('size')).toHaveTextContent('256');
    expect(screen.getByTestId('drawer')).toHaveStyle({ height: '256px' });
  });

  it('resizes by dragging', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator');
    // jsdom lacks pointer capture.
    handle.setPointerCapture = () => undefined;
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = () => undefined;
    fireEvent.pointerDown(handle, { button: 0, clientX: 240, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(screen.getByTestId('size')).toHaveTextContent('300');
    fireEvent.pointerMove(handle, { clientX: 1000, pointerId: 1 });
    expect(screen.getByTestId('size')).toHaveTextContent('480');
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 });
    expect(screen.getByTestId('size')).toHaveTextContent('480');
  });

  it('closes from its close button and returns focus to the toggle', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Close outline' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle outline' })).toHaveFocus();
  });
});
