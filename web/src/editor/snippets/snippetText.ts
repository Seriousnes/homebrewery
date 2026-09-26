// The text form of a brew's snippets (upstream's Snippets tab: legacy editor.jsx, and helpers.js
// yamlSnippetsToText / brewSnippetsToJSON). A line "\snippet <name>" starts a snippet; its
// Homebrewery markdown runs up to the next such line:
//
//   \snippet Tavern note
//   {{note
//   ##### The Prancing Pony
//   }}
//   \snippet Monsters › Goblin
//   …
//
// A group may go before the name, separated by "›" (GROUP_SEPARATOR, the Insert menu's path
// separator). Upstream has no groups: it reads such a line as a snippet named "Monsters › Goblin".
//
// Parsing follows upstream's rules for the header (a backslash, "snippet", one or more spaces, a
// name; a header whose name is blank is skipped with its body) and for the body (everything up to
// the next header, without the line break before it). Two deliberate differences keep a round trip
// through snippetsToText exact: a final header without a line break after it still counts, and
// only one line break is dropped at the very end (upstream trims the whole text).

/** Written between a snippet's group and its name in the text form. */
export const GROUP_SEPARATOR = ' › ';

/** A header line: "\snippet" and at least one space (upstream's /^\\snippet +.+$/). */
const HEADER = /^\\snippet +(.*)$/;

export interface TextSnippet {
  /** '' = no group (the Insert menu lists it under the brew's title). */
  group: string;
  name: string;
  /** The snippet's Homebrewery markdown. */
  gen: string;
}

export interface ParsedSnippetText {
  snippets: TextSnippet[];
  /** Text before the first header (it belongs to no snippet), trimmed; '' when there is none. */
  ignored: string;
  /** Headers with a blank name, skipped with their bodies (as upstream). */
  skipped: number;
}

/** Whether `line` would start a new snippet in the text form. */
export function isSnippetHeader(line: string): boolean {
  return HEADER.test(line);
}

/** "Group › Name" → { group, name }; a label without "›" is a name. Both are trimmed. */
export function splitGroupAndName(label: string): { group: string; name: string } {
  const at = label.indexOf('›');
  if (at < 0) return { group: '', name: label.trim() };
  return { group: label.slice(0, at).trim(), name: label.slice(at + 1).trim() };
}

/** The header label of a snippet: its name, after its group when it has one. */
export function snippetLabel(group: string | undefined, name: string): string {
  const g = group?.trim() ?? '';
  return g ? `${g}${GROUP_SEPARATOR}${name}` : name;
}

/** Reads the text form. Line breaks may be \n, \r\n or \r. */
export function parseSnippetText(text: string): ParsedSnippetText {
  const normalized = text.replace(/\r\n?/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const snippets: TextSnippet[] = [];
  const preamble: string[] = [];
  let skipped = 0;
  // null: before the first header; 'skip': inside a skipped snippet.
  let current: { group: string; name: string; lines: string[] } | 'skip' | null = null;
  const flush = () => {
    if (current && current !== 'skip') snippets.push({ group: current.group, name: current.name, gen: current.lines.join('\n') });
  };
  for (const line of body === '' ? [] : body.split('\n')) {
    const header = HEADER.exec(line);
    if (header) {
      flush();
      const label = header[1]!.trim();
      if (!label) {
        skipped++;
        current = 'skip';
      } else {
        current = { ...splitGroupAndName(label), lines: [] };
      }
      continue;
    }
    if (current === null) preamble.push(line);
    else if (current !== 'skip') current.lines.push(line);
  }
  flush();
  return { snippets, ignored: preamble.join('\n').trim(), skipped };
}

/** The text form of `snippets` (each header, then its markdown, then a line break). */
export function snippetsToText(snippets: ReadonlyArray<{ group?: string; name: string; gen: string }>): string {
  return snippets.map((s) => `\\snippet ${snippetLabel(s.group, s.name.trim())}\n${s.gen}\n`).join('');
}

/** Whether a snippet's markdown has a line the text form would read as a new snippet. */
export function hasSnippetHeaderLine(gen: string): boolean {
  return gen.split(/\r\n?|\n/).some(isSnippetHeader);
}
