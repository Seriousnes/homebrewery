import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { CssFormatError, formatCss, minimalChange } from './formatCss';

export type FormatOutcome =
  | { kind: 'formatted' }
  | { kind: 'unchanged' }
  /** The CSS changed while Prettier ran; nothing was applied. */
  | { kind: 'stale' }
  | { kind: 'error'; message: string; line: number | null; column: number | null }
  /** Prettier could not be loaded. */
  | { kind: 'unavailable'; message: string };

/**
 * Formats the view's selection (or all of it when nothing is selected) with Prettier and applies
 * the smallest change, as one undo step of its own. Nothing happens when the text changed while
 * Prettier ran.
 */
export async function formatView(view: EditorView): Promise<FormatOutcome> {
  const state = view.state;
  const { from, to, empty } = state.selection.main;
  const code = empty ? state.doc.toString() : state.sliceDoc(from, to);
  let formatted: string;
  try {
    formatted = await formatCss(code);
  } catch (error) {
    if (error instanceof CssFormatError) return { kind: 'error', message: error.message, line: error.line, column: error.column };
    return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
  }
  if (view.state.doc !== state.doc) return { kind: 'stale' };
  if (!empty) formatted = formatted.replace(/\n+$/, '');
  const change = minimalChange(code, formatted);
  if (!change) return { kind: 'unchanged' };
  const base = empty ? 0 : from;
  view.dispatch({
    changes: { from: base + change.from, to: base + change.to, insert: change.insert },
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('format')],
  });
  return { kind: 'formatted' };
}
