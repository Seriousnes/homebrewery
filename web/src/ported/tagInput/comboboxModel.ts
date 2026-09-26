// Options and filtering of the Combobox (kept apart from the component for react-refresh and tests).
import type { Ref } from 'react';

/** Sets a callback or object ref. */
export function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export interface ComboboxOption {
  /** Unique within its group; what onSelect receives. */
  value: string;
  /** The visible text (and the option's accessible name, with detail). */
  label: string;
  /** Secondary text after the label (a language's own name, a theme's author). */
  detail?: string;
  /** Group heading; options of one group must be consecutive. */
  group?: string;
  /** More text that typing matches (not shown). */
  keywords?: readonly string[];
  /** Decorative image before the label (theme textures). */
  image?: string;
  /** Styling hook (data-tone), e.g. a tag's type. */
  tone?: string;
  disabled?: boolean;
}

/** 'startsWith' matches the start of any word; 'includes' any substring; 'none' shows all. */
export type ComboboxFilter = 'startsWith' | 'includes' | 'none';

function matches(text: string, query: string, filter: ComboboxFilter): boolean {
  const haystack = text.toLowerCase();
  if (filter === 'includes') return haystack.includes(query);
  if (haystack.startsWith(query)) return true;
  // Word starts: "5e" matches "D&D 5e", "the" matches "Vampire: The Masquerade".
  return haystack.split(/[\s:/(),-]+/).some((word) => word.startsWith(query));
}

/** The options that match `text` (case-insensitive; label, value, detail and keywords), at most `max`. */
export function filterOptions(options: readonly ComboboxOption[], text: string, filter: ComboboxFilter = 'includes', max = 200): ComboboxOption[] {
  const query = text.trim().toLowerCase();
  const result: ComboboxOption[] = [];
  for (const option of options) {
    if (result.length >= max) break;
    if (
      filter === 'none' ||
      query === '' ||
      [option.label, option.value, option.detail ?? '', ...(option.keywords ?? [])].some((t) => matches(t, query, filter))
    ) {
      result.push(option);
    }
  }
  return result;
}
