// Typeahead for menus and lists (WAI-ARIA APG): typing characters moves focus to the next item
// whose label starts with them. Typing the same character repeatedly cycles through the items that
// start with it.

export const TYPEAHEAD_TIMEOUT_MS = 500;

/** True for keys that type a character (no modifiers other than Shift). */
export function isTypeaheadKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export interface Typeahead {
  /** Add a typed character; returns the search string so far. */
  push(char: string, now?: number): string;
  reset(): void;
}

export function createTypeahead(timeoutMs: number = TYPEAHEAD_TIMEOUT_MS): Typeahead {
  let search = '';
  let last = -Infinity;
  return {
    push(char, now = Date.now()) {
      if (now - last > timeoutMs) search = '';
      last = now;
      search += char.toLowerCase();
      return search;
    },
    reset() {
      search = '';
      last = -Infinity;
    },
  };
}

/**
 * Index of the item to focus for `search`, or -1. A single repeated character searches from the
 * item after `current`; a longer string from `current` itself (so typing on keeps the match).
 * Disabled items are skipped.
 */
export function findTypeaheadMatch(
  labels: readonly string[],
  search: string,
  current: number,
  isDisabled: (index: number) => boolean = () => false,
): number {
  if (!search || labels.length === 0) return -1;
  const chars = Array.from(search);
  const repeated = chars.every((c) => c === chars[0]);
  const needle = repeated ? chars[0]! : search;
  const start = repeated || current < 0 ? current + 1 : current;
  for (let i = 0; i < labels.length; i++) {
    const index = (((start + i) % labels.length) + labels.length) % labels.length;
    if (isDisabled(index)) continue;
    if (labels[index]!.trim().toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}
