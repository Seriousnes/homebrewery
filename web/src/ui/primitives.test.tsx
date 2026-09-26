import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Icon } from './Icon';
import { ICON_NAMES } from './iconPaths';
import { IconButton } from './IconButton';
import { Portal } from './Portal';
import { Spinner } from './Spinner';
import { UiRoot } from './UiRoot';
import { VisuallyHidden } from './VisuallyHidden';

describe('Button', () => {
  it('is type=button by default and reports toggle state', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button pressed={false} icon="bold" onClick={onClick}>
        Bold
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Bold' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('while loading stays focusable, is busy and ignores clicks', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
    button.focus();
    expect(button).toHaveFocus();
  });

  it('aria-disabled blocks clicks too', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button aria-disabled onClick={onClick}>
        Publish
      </Button>,
    );
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Icon', () => {
  it('is decorative unless labelled', () => {
    const { container } = render(
      <>
        <Icon name="trash" />
        <Icon name="warning" label="Warning" />
      </>,
    );
    expect(container.querySelector('[data-icon="trash"]')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('img', { name: 'Warning' })).toBeInTheDocument();
  });

  it('covers the editor set', () => {
    for (const name of [
      'bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript', 'link', 'bulletList', 'orderedList',
      'heading', 'heading1', 'heading2', 'heading3', 'alignLeft', 'alignCenter', 'alignRight', 'alignJustify', 'pageBreak',
      'columnBreak', 'undo', 'redo', 'zoomIn', 'zoomOut', 'spreadSingle', 'spreadFacing', 'spreadFlow', 'saved', 'saving',
      'unsaved', 'saveError', 'insert', 'image', 'table', 'trash', 'settings', 'close', 'chevronDown', 'search', 'user',
      'lock', 'warning', 'info', 'check', 'dragHandle', 'eye',
    ]) {
      expect(ICON_NAMES).toContain(name);
    }
  });
});

describe('IconButton, Spinner, VisuallyHidden, UiRoot, Portal', () => {
  it('IconButton is named by its label', () => {
    render(<IconButton icon="trash" label="Delete page" tooltip={false} />);
    expect(screen.getByRole('button', { name: 'Delete page' })).toBeInTheDocument();
  });

  it('Spinner announces its label unless decorative', () => {
    const { container } = render(
      <>
        <Spinner label="Saving" />
        <Spinner decorative className="deco" />
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Saving');
    expect(container.querySelector('svg.deco')).toHaveAttribute('aria-hidden', 'true');
  });

  it('VisuallyHidden keeps text in the accessibility tree', () => {
    render(
      <button type="button">
        <Icon name="close" />
        <VisuallyHidden>Close</VisuallyHidden>
      </button>,
    );
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('UiRoot carries tokens and a forced color scheme into portals', () => {
    render(
      <UiRoot colorScheme="dark" data-testid="root">
        <Portal>
          <p>In a layer</p>
        </Portal>
      </UiRoot>,
    );
    expect(screen.getByTestId('root')).toHaveAttribute('data-color-scheme', 'dark');
    const layer = screen.getByText('In a layer').parentElement!;
    expect(layer).toHaveAttribute('data-hb-layer', 'layer');
    expect(layer).toHaveAttribute('data-color-scheme', 'dark');
    expect(layer.parentElement).toHaveAttribute('data-hb-portal-root');
    expect(screen.getByTestId('root').contains(layer)).toBe(false);
  });
});
