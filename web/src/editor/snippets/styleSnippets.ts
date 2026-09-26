// Style-view snippets (plan §6.3: "Style-view snippets insert into the Style drawer"). The
// drawer (inspector lane, CodeMirror) owns the text; these helpers produce what to insert.
//
//   const groups = groupsForView(compiled, 'style');          // compileSnippets.ts
//   const text = generateStyleSnippet(entry, brew);            // CSS text
//   view.dispatch(view.state.replaceSelection(text));          // CodeMirror, or:
//   const { css, cursor } = insertStyleSnippet(style, text, { from, to });
import { runSnippetGenerator, snippetContext, type SnippetBrewInfo } from './generate';
import type { SnippetEntry } from './snippetTree';

/** Runs a style snippet's generator (CSS text). Throws SnippetGeneratorError. */
export function generateStyleSnippet(entry: Pick<SnippetEntry, 'name' | 'gen'>, brew: SnippetBrewInfo = {}): string {
  return runSnippetGenerator(entry.name, entry.gen, snippetContext(brew, 'style'));
}

/**
 * Inserts `snippet` into `css` at `range` (default: the end, on a line of its own after a
 * blank line). Returns the new text and the cursor position after the snippet.
 */
export function insertStyleSnippet(css: string, snippet: string, range?: { from: number; to: number }): { css: string; cursor: number } {
  if (range) {
    const from = Math.max(0, Math.min(range.from, css.length));
    const to = Math.max(from, Math.min(range.to, css.length));
    return { css: css.slice(0, from) + snippet + css.slice(to), cursor: from + snippet.length };
  }
  const trimmed = css.replace(/\s+$/, '');
  const separator = trimmed ? '\n\n' : '';
  const text = snippet.replace(/^\s+/, '');
  const out = `${trimmed}${separator}${text}`;
  return { css: out.endsWith('\n') ? out : `${out}\n`, cursor: trimmed.length + separator.length + text.length };
}
