// Style drawer (P3.6) in jsdom: controlled value, onChange per edit, formatting (keys, button,
// one undo step, errors), the snippet slot, and the colour scheme. How edits reach the canvas
// (after the userCssDelayMs debounce, in one new stylesheet) is web/e2e/inspector/style.spec.ts.
import { redo, undo } from '@codemirror/commands';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { UiRoot } from '@/ui';
import type { StyleEditorApi, StyleEditorHandle } from './StyleEditor';
import { StyleDrawer } from './StyleDrawer';

// jsdom has no layout: CodeMirror's measuring asks ranges for rects.
beforeAll(() => {
  const proto = Range.prototype as Partial<Pick<Range, 'getClientRects' | 'getBoundingClientRect'>>;
  const empty = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
  proto.getClientRects ??= () => Object.assign([], { item: () => null });
  proto.getBoundingClientRect ??= () => empty;
});

function Harness({ initial, onChange, snippets }: { initial: string; onChange?: (css: string) => void; snippets?: (api: StyleEditorApi) => React.ReactNode }) {
  const [css, setCss] = useState(initial);
  return (
    <UiRoot colorScheme="light">
      <StyleDrawer
        value={css}
        onChange={(next) => {
          setCss(next);
          onChange?.(next);
        }}
        snippets={snippets}
        classNames={() => ['monster']}
      />
      <output data-testid="value">{css}</output>
      <button type="button" onClick={() => setCss('.reset { color: blue; }')}>
        reset
      </button>
    </UiRoot>
  );
}

function viewOf(): EditorView {
  const dom = screen.getByTestId('style-editor').querySelector<HTMLElement>('.cm-editor')!;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('no CodeMirror view');
  return view;
}

describe('StyleDrawer', () => {
  it('reports every edit and follows a new value from outside without echoing it', async () => {
    const onChange = vi.fn();
    render(<Harness initial=".page { color: red; }" onChange={onChange} />);
    const view = viewOf();
    expect(view.state.doc.toString()).toBe('.page { color: red; }');
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '\n.a { b: c; }' } }));
    expect(onChange).toHaveBeenLastCalledWith('.page { color: red; }\n.a { b: c; }');
    expect(screen.getByTestId('value')).toHaveTextContent('.a { b: c; }');
    onChange.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect(view.state.doc.toString()).toBe('.reset { color: blue; }');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a late render of an older value (the parent behind the typing) does not undo newer edits', () => {
    const onChange = vi.fn();
    const drawer = (value: string) => (
      <UiRoot>
        <StyleDrawer value={value} onChange={onChange} />
      </UiRoot>
    );
    const { rerender } = render(drawer(''));
    const view = viewOf();
    act(() => view.dispatch({ changes: { from: 0, insert: 'a' }, selection: { anchor: 1 } }));
    act(() => view.dispatch({ changes: { from: 1, insert: 'b' }, selection: { anchor: 2 } }));
    expect(onChange.mock.calls.map(([css]) => css as string)).toEqual(['a', 'ab']);
    rerender(drawer('a')); // the render for the first keystroke arrives after the second
    expect(view.state.doc.toString()).toBe('ab');
    expect(view.state.selection.main.head).toBe(2);
    rerender(drawer('ab'));
    expect(view.state.doc.toString()).toBe('ab');
    rerender(drawer('.new { }')); // a genuinely new value
    expect(view.state.doc.toString()).toBe('.new { }');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('the text box is labelled and described', () => {
    render(<Harness initial="" />);
    const box = screen.getByRole('textbox', { name: 'Brew CSS' });
    expect(box).toHaveAttribute('aria-describedby');
    expect(box).toHaveAccessibleDescription(/formats.*Esc then Tab leaves the editor/);
  });

  it('Mod-Shift-F formats as one undo step and announces it', async () => {
    render(<Harness initial=".page{color:red;margin:0}" />);
    const view = viewOf();
    const event = new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', keyCode: 70, ctrlKey: true, shiftKey: true, bubbles: true });
    expect(runScopeHandlers(view, event, 'editor')).toBe(true);
    await waitFor(() => expect(view.state.doc.toString()).toBe('.page {\n  color: red;\n  margin: 0;\n}\n'));
    expect(screen.getByTestId('value')).toHaveTextContent('margin: 0;');
    expect(screen.getByTestId('style-status')).toHaveTextContent('CSS formatted.');
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('.page{color:red;margin:0}');
    act(() => void redo(view));
    expect(view.state.doc.toString()).toContain('margin: 0;');
  });

  it('Alt-Shift-F formats only the selection', async () => {
    render(<Harness initial={'.keep{a:b}\n.fmt{c:d;e:f}'} />);
    const view = viewOf();
    act(() => view.dispatch({ selection: { anchor: 11, head: view.state.doc.length } }));
    const event = new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', keyCode: 70, altKey: true, shiftKey: true, bubbles: true });
    expect(runScopeHandlers(view, event, 'editor')).toBe(true);
    await waitFor(() => expect(view.state.doc.toString()).toBe('.keep{a:b}\n.fmt {\n  c: d;\n  e: f;\n}'));
  });

  it('the Format button reports CSS it cannot read, and changes nothing', async () => {
    render(<Harness initial={'.page {\n  color: red;\n'} />);
    const view = viewOf();
    await userEvent.click(screen.getByRole('button', { name: 'Format' }));
    await waitFor(() => expect(screen.getByTestId('style-status')).toHaveTextContent(/Can’t format: .*line 1/));
    expect(view.state.doc.toString()).toBe('.page {\n  color: red;\n');
  });

  it('already formatted CSS is left alone', async () => {
    render(<Harness initial={'.page { color: red; }\n'} />);
    await userEvent.click(screen.getByRole('button', { name: 'Format' }));
    await waitFor(() => expect(screen.getByTestId('style-status')).toHaveTextContent('already formatted'));
    expect(viewOf().state.doc.toString()).toBe('.page { color: red; }\n');
  });

  it('snippet slot: the API inserts at the cursor as one undo step', async () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial=".a { }"
        onChange={onChange}
        snippets={(api) => (
          <button type="button" onClick={() => api.insert('.monster { color: red; }')}>
            Insert snippet
          </button>
        )}
      />,
    );
    const view = viewOf();
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    await userEvent.click(screen.getByRole('button', { name: 'Insert snippet' }));
    expect(view.state.doc.toString()).toBe('.a { }.monster { color: red; }');
    expect(onChange).toHaveBeenLastCalledWith('.a { }.monster { color: red; }');
    expect(view.hasFocus).toBe(true);
    act(() => void undo(view));
    expect(view.state.doc.toString()).toBe('.a { }');
  });

  it('follows the colour scheme', () => {
    const { rerender } = render(
      <UiRoot colorScheme="dark">
        <StyleDrawer value="" onChange={() => {}} />
      </UiRoot>,
    );
    expect(screen.getByTestId('style-editor')).toHaveAttribute('data-scheme', 'dark');
    rerender(
      <UiRoot colorScheme="light">
        <StyleDrawer value="" onChange={() => {}} />
      </UiRoot>,
    );
    expect(screen.getByTestId('style-editor')).toHaveAttribute('data-scheme', 'light');
  });

  it('exposes the editor handle through ref', () => {
    let handle: StyleEditorHandle | null = null;
    render(
      <UiRoot>
        <StyleDrawer
          value=".x { }"
          onChange={() => {}}
          ref={(h) => {
            handle = h;
          }}
        />
      </UiRoot>,
    );
    expect(handle!.getValue()).toBe('.x { }');
    expect(handle!.view).toBeInstanceOf(EditorView);
  });

  it('read-only: no edits, format disabled', () => {
    render(
      <UiRoot>
        <StyleDrawer value=".x { }" onChange={() => {}} readOnly />
      </UiRoot>,
    );
    expect(viewOf().state.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Format' })).toBeDisabled();
  });
});
