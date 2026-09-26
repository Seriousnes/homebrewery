// The brew's own snippets as the snippets editor stores them (brews.snippets; plan §8.2:
// jsonb [{ group, name, gen }]) and the server's size rule for them (BrewRules.Snippets: a JSON
// array or null, at most MaxSnippets = 2 MB measured as the JSON the server stores).
//
// Stored form written by the editor: [{ group?, name, gen }] in list order; `group` is left out
// when empty (the Insert menu then lists the snippet under the brew's title), names and groups are
// trimmed, and an empty list is null. parseUserSnippets (userSnippets.ts) reads it, like every
// older shape.
import { parseUserSnippets } from './userSnippets';

/** BrewRules.MaxSnippets: the stored JSON's length (UTF-16 code units), as the server writes it. */
export const MAX_SNIPPETS_JSON = 2 * 1024 * 1024;

export interface StoredUserSnippet {
  group?: string;
  name: string;
  gen: string;
}

/** A user snippet as the editor edits it: every field a string ('' = none). */
export interface UserSnippetFields {
  group: string;
  name: string;
  gen: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** One snippet in its stored form. */
export function storedSnippet(snippet: UserSnippetFields): StoredUserSnippet {
  const group = snippet.group.trim();
  const name = snippet.name.trim();
  return group ? { group, name, gen: snippet.gen } : { name, gen: snippet.gen };
}

/** The value to store for `snippets` (null when there are none). */
export function storedSnippets(snippets: readonly UserSnippetFields[]): StoredUserSnippet[] | null {
  return snippets.length ? snippets.map(storedSnippet) : null;
}

/**
 * The brew's stored snippets (any shape parseUserSnippets accepts) as editable fields, in order.
 * Unlike parseUserSnippets it keeps flat entries without a name or body, so what the editor
 * saved mid-edit (a snippet whose name was cleared) comes back as it was.
 */
export function editableUserSnippets(value: unknown): UserSnippetFields[] {
  if (!Array.isArray(value)) return parseUserSnippets(value).map((s) => ({ group: s.group ?? '', name: s.name, gen: s.gen }));
  const out: UserSnippetFields[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.subsnippets)) {
      // Upstream's stored form: one group per entry.
      for (const s of parseUserSnippets([entry])) out.push({ group: s.group ?? '', name: s.name, gen: s.gen });
      continue;
    }
    const name = str(entry.name);
    const gen = str(entry.gen);
    if (name === null && gen === null) continue;
    out.push({ group: str(entry.group)?.trim() ?? '', name: name?.trim() ?? '', gen: gen ?? '' });
  }
  return out;
}

/**
 * Length of a JSON string literal as System.Text.Json writes it with its default encoder (what
 * JsonNode.ToJsonString() gives the server's size check): '"' and the HTML-sensitive < > & ' + `
 * become \uXXXX, as do other control characters, DEL and every non-ASCII UTF-16 code unit;
 * \b \f \n \r \t and \\ take two characters. U+0000 is removed before storing (StoredText.Clean).
 */
export function jsonStringLength(text: string): number {
  let length = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0) continue;
    if (c >= 0x80 || c === 0x7f) length += 6;
    else if (c === 0x5c || c === 0x08 || c === 0x0c || c === 0x0a || c === 0x0d || c === 0x09) length += 2;
    else if (c < 0x20) length += 6;
    else if (c === 0x22 || c === 0x3c || c === 0x3e || c === 0x26 || c === 0x27 || c === 0x2b || c === 0x60) length += 6;
    else length += 1;
  }
  return length;
}

/**
 * Length of `value` as the server stores it (JsonNode.ToJsonString(): no spaces, the escaping of
 * jsonStringLength). Values JSON.stringify drops (undefined, functions) count as it does.
 */
export function serverJsonLength(value: unknown): number {
  if (value === null) return 4;
  switch (typeof value) {
    case 'string':
      return jsonStringLength(value);
    case 'boolean':
      return value ? 4 : 5;
    case 'number':
      return Number.isFinite(value) ? String(value).length : 4;
    case 'object': {
      if (Array.isArray(value)) {
        let length = 2 + Math.max(0, value.length - 1);
        for (const item of value) length += item === undefined || typeof item === 'function' ? 4 : serverJsonLength(item);
        return length;
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && typeof v !== 'function');
      let length = 2 + Math.max(0, entries.length - 1);
      for (const [key, v] of entries) length += jsonStringLength(key) + 1 + serverJsonLength(v);
      return length;
    }
    default:
      return 0;
  }
}

/** Whether the stored value fits the server's limit. */
export function snippetsFit(value: unknown, max = MAX_SNIPPETS_JSON): boolean {
  return serverJsonLength(value) <= max;
}
