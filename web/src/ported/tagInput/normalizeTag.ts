// Tag rules ported from legacy/client/homebrew/editor/tagInput/tagInput.jsx (normalizeValue) and
// metadataEditor.jsx (the tag pattern). Kept free of React so the rules can be unit tested.
import { TAG_CANONICAL_FORMS } from './tagSuggestions';

/**
 * Upstream's tag pattern: an optional `group:`, `meta:`, `system:` or `type:` prefix, then 1-41
 * characters from letters, digits, space and `/ \ . & _ -`, starting with a letter or digit.
 */
export const TAG_PATTERN = /^\s*(?:(?:group|meta|system|type)\s*:\s*)?[A-Za-z0-9][A-Za-z0-9 /\\.&_-]{0,40}\s*$/;

/** The server keeps at most this many tags (BrewRules.MaxTags). */
export const MAX_TAGS = 50;

/** Tag prefixes that upstream colours on the user page. */
export const TAG_TYPES = ['type', 'group', 'meta', 'system'] as const;
export type TagType = (typeof TAG_TYPES)[number];

/** The prefix type of a tag (`system:D&D 5e` → 'system'), or null for a plain tag. */
export function tagType(tag: string): TagType | null {
  const colon = tag.indexOf(':');
  if (colon < 0) return null;
  const prefix = tag.slice(0, colon).trim().toLowerCase();
  return (TAG_TYPES as readonly string[]).includes(prefix) ? (prefix as TagType) : null;
}

/**
 * Replaces known spellings with their canonical form (`dnd` → `D&D`, `5th Edition` → `5e`),
 * case-insensitively, at most once per group, then tidies a `type:value` tag: the type is
 * lower-cased, spaces around the colon are removed and the value's first letter is upper-cased.
 *
 * Upstream matched every group against the original text, so a later group could undo an earlier
 * one ('5.5e' became '5e 2024' and then '5.5e' again); here each group sees the result of the
 * previous ones.
 */
export function normalizeTag(input: string, canonicalForms: readonly (readonly string[])[] = TAG_CANONICAL_FORMS): string {
  let tag = input;
  for (const group of canonicalForms) {
    const canonical = group[0];
    if (!canonical) continue;
    const lower = tag.toLowerCase();
    for (const variant of group) {
      if (!variant) continue;
      const index = lower.indexOf(variant.toLowerCase());
      if (index !== -1) {
        tag = tag.slice(0, index) + canonical + tag.slice(index + variant.length);
        break;
      }
    }
  }

  const colon = tag.indexOf(':');
  if (colon !== -1) {
    const type = tag.slice(0, colon).trim().toLowerCase();
    // Upstream kept only the text up to a second colon; keep the rest of the value instead.
    const value = tag.slice(colon + 1).trim();
    if (value.length > 0) tag = `${type}:${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  }
  return tag;
}

/** Why `raw` can't be added to `tags` (null when it can). */
export function tagProblem(raw: string, tags: readonly string[], { pattern = TAG_PATTERN, max = MAX_TAGS, ignoreIndex }: TagCheckOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return 'Enter a tag.';
  if (pattern && !pattern.test(trimmed)) return 'Tags start with a letter or digit and use letters, digits, spaces and / \\ . & _ - (at most 41 characters, after an optional type: prefix).';
  const normalized = normalizeTag(trimmed).toLowerCase();
  if (tags.some((t, i) => i !== ignoreIndex && t.toLowerCase() === normalized)) return 'That tag is already in the list.';
  if (ignoreIndex === undefined && tags.length >= max) return `A brew can have at most ${max} tags.`;
  return null;
}

export interface TagCheckOptions {
  /** null skips the pattern (curated suggestions, some of which contain a second colon). */
  pattern?: RegExp | null;
  max?: number;
  /** When editing a tag in place: its index (it doesn't count as a duplicate or towards the limit). */
  ignoreIndex?: number;
}
