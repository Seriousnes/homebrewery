// InspectorPanel and StylePanel: Drawers wired to the UI store ('inspector' and 'style' panels).
import { Editor } from '@tiptap/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PANEL_LIMITS, uiStore } from '@/app/uiStore';
import { buildEditorExtensions } from '@/editor/editorExtensions';
import { docWith, p } from '@/editor/schema/testing';
import { UiRoot } from '@/ui';
import { StylePanel } from '../styleDrawer/StylePanel';
import { InspectorPanel } from './InspectorPanel';

let editor: Editor | null = null;
beforeEach(() => uiStore.getState().resetUi());
afterEach(() => {
  editor?.destroy();
  editor = null;
});

// jsdom has no layout: CodeMirror's measuring asks ranges for rects.
const proto = Range.prototype as Partial<Pick<Range, 'getClientRects' | 'getBoundingClientRect'>>;
proto.getClientRects ??= () => Object.assign([], { item: () => null });
const emptyRect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
proto.getBoundingClientRect ??= () => emptyRect;

describe('InspectorPanel', () => {
  it('follows the UI store: opens, resizes and closes through it', async () => {
    editor = new Editor({ extensions: buildEditorExtensions(), content: docWith(p('Hello')) });
    act(() => uiStore.getState().setPanelOpen('inspector', false));
    render(
      <UiRoot>
        <InspectorPanel editor={editor} />
      </UiRoot>,
    );
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    act(() => uiStore.getState().setPanelOpen('inspector', true));
    const panel = screen.getByRole('complementary', { name: 'Inspector' });
    expect(panel).toHaveAttribute('id', 'hb-inspector-panel');
    expect(screen.getByRole('tab', { name: 'Element' })).toBeInTheDocument();
    const handle = screen.getByRole('separator', { name: 'Resize inspector' });
    expect(handle).toHaveAttribute('aria-valuemin', String(PANEL_LIMITS.inspector.min));
    handle.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(uiStore.getState().panels.inspector.size).toBe(316);
    await userEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(uiStore.getState().panels.inspector.open).toBe(false);
  });

  it('shows a spinner until there is an editor', () => {
    act(() => uiStore.getState().setPanelOpen('inspector', true));
    render(
      <UiRoot>
        <InspectorPanel editor={null} />
      </UiRoot>,
    );
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toHaveTextContent('Loading the editor');
  });
});

describe('StylePanel', () => {
  it('holds the Style drawer and follows the UI store', async () => {
    act(() => uiStore.getState().setPanelOpen('style', true));
    render(
      <UiRoot>
        <StylePanel value=".page { }" onChange={() => {}} side="right" />
      </UiRoot>,
    );
    expect(screen.getByRole('complementary', { name: 'Style' })).toHaveAttribute('id', 'hb-style-panel');
    expect(screen.getByRole('textbox', { name: 'Brew CSS' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close style drawer' }));
    expect(uiStore.getState().panels.style.open).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Brew CSS' })).toBeNull();
  });
});
