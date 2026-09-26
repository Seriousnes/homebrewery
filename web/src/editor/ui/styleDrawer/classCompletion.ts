// Theme-aware completion for the Style drawer: after a "." in a selector, suggest the class names
// the brew's theme stylesheets use (the inspector's canvasClassNames). Declaration values
// ("margin: 0.5em") are left to lang-css's own completion.
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';

/**
 * Whether `pos` is in a selector rather than in a declaration: outside any block, or inside one
 * (nested rules, @media) with no ":" since the last "{", "}" or ";". Comments and strings are
 * skipped. Pseudo-classes in nested selectors (&:hover .x) count as declarations: a rare miss.
 */
export function inSelector(text: string): boolean {
  let depth = 0;
  let colon = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return false; // inside a comment
      i = end + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) return false; // inside a string
      i = j;
    } else if (c === '\\') i++;
    else if (c === '{') {
      depth++;
      colon = false;
    } else if (c === '}') {
      depth = Math.max(0, depth - 1);
      colon = false;
    } else if (c === ';') colon = false;
    else if (c === ':') colon = true;
  }
  return depth === 0 || !colon;
}

/** A completion source offering `names()` after a "." in selector position. */
export function classNameCompletion(names: () => readonly string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\.-?[_\p{L}][\p{L}\p{N}_-]*$|\.$/u);
    if (!word || !inSelector(context.state.sliceDoc(0, word.from))) return null;
    const options = names().map((name) => ({ label: name, type: 'class', detail: 'theme' }));
    if (options.length === 0) return null;
    return { from: word.from + 1, options, validFor: /^[\p{L}\p{N}_-]*$/u };
  };
}
