// Field rules ported from legacy/client/homebrew/editor/metadataEditor/validations.js, with the
// upstream messages. Two additions mirror the server (src/Homebrewery.Api/Brews/BrewRules.cs):
// thumbnails must be http(s) URLs, and handles for invited authors follow Handles.IsValid.

export type Rule = (value: string, context: ValidationContext) => string | null;

export interface ValidationContext {
  /** This site's origin, for share URLs typed into the theme field (upstream: config.baseUrl). */
  baseUrl: string;
}

/** Delay before a rule message shows while the user is typing (ms; upstream debounced 300 ms). */
export const ERROR_DELAY_MS = 300;

export const MAX_TITLE = 100;
export const MAX_DESCRIPTION = 500;
export const MAX_THUMBNAIL_URL = 256;

/** Upstream's language rule (also the server's): en, pt-BR, zh-Hant, es-419. */
export const LANG_PATTERN = /^([a-zA-Z]{2,3})(-[a-zA-Z]{4})?(-(?:[0-9]{3}|[a-zA-Z]{2}))?$/;

/** A share id (Nanoid, 12 characters). */
export const SHARE_ID_PATTERN = /^[a-zA-Z0-9_-]{12}$/;

/** Handles (server Handles.IsValid, after trimming and lower-casing). */
export const HANDLE_PATTERN = /^[a-z0-9_-]{3,32}$/;

const escapeRegExp = (text: string) => text.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

/** The share id in `value` when it is a share id or this site's share URL; otherwise null. */
export function parseShareReference(value: string, baseUrl: string): string | null {
  const text = value.trim();
  if (SHARE_ID_PATTERN.test(text)) return text;
  const base = escapeRegExp(baseUrl.replace(/\/+$/, ''));
  const match = new RegExp(`^${base}\\/share\\/([a-zA-Z0-9_-]{12})\\/?$`).exec(text);
  return match?.[1] ?? null;
}

export const validations = {
  title: [(value) => (value.length > MAX_TITLE ? `Max title length of ${MAX_TITLE} characters` : null)],
  description: [(value) => (value.length > MAX_DESCRIPTION ? `Max description length of ${MAX_DESCRIPTION} characters.` : null)],
  thumbnailUrl: [
    (value) => (value.length > MAX_THUMBNAIL_URL ? `Max URL length of ${MAX_THUMBNAIL_URL} characters.` : null),
    (value) => {
      if (value.trim().length === 0) return null;
      try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'Must be a valid URL';
      } catch {
        return 'Must be a valid URL';
      }
    },
  ],
  lang: [(value) => (value.length > 0 && !LANG_PATTERN.test(value) ? 'Invalid language code.' : null)],
  theme: [
    (value, { baseUrl }) =>
      value.length === 0 || parseShareReference(value, baseUrl) !== null ? null : 'Must be a valid Share URL or a 12-character ID.',
  ],
} satisfies Record<string, Rule[]>;

export type ValidatedField = keyof typeof validations;

/** Every message the rules of `field` give for `value` (empty when valid). */
export function validateField(field: ValidatedField, value: string, context: ValidationContext): string[] {
  const rules: readonly Rule[] = validations[field];
  return rules.map((rule) => rule(value, context)).filter((m): m is string => m !== null);
}

/** Why `raw` can't be invited (null when it can): the handle format and people already listed. */
export function inviteProblem(raw: string, listed: readonly string[]): string | null {
  const handle = normalizeHandle(raw);
  if (!handle) return 'Enter a handle.';
  if (!HANDLE_PATTERN.test(handle)) return "A handle is 3 to 32 characters: lower-case letters a-z, digits, '-' and '_'.";
  if (listed.includes(handle)) return `${handle} is already on the author list.`;
  return null;
}

/** Handles are stored trimmed and lower-cased (server Handles.Normalize). */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}
