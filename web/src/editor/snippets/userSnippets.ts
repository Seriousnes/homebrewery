// User snippets (plan §6.3: "\snippet name" bodies are HBFM and go through the same pipeline)
// and user-theme snippets, as snippet-bar groups. Port of the brewSnippetsToJSON part of
// legacy snippetbar.jsx compileSnippets (:152-153).
//
// Stored shapes accepted (brews.snippets is jsonb; plan §8.2 says [{ group, name, gen }]):
//   "\snippet Name\n<markdown>\n…"                       upstream's text form (yamlSnippetsToText)
//   [{ name, subsnippets: [{ name, gen }] }]              upstream's stored form (brewSnippetsToJSON)
//   [{ group?, name, gen }]                               the plan's flat form
// Anything else is ignored.
import { brewSnippetsToJSON } from '../import/brewText';
import type { ThemeSnippet, ThemeSnippetGroup } from './themeSnippets';

/** A user snippet, flattened. `group` is the submenu it belongs to (default: the brew title). */
export interface UserSnippet {
  group?: string;
  name: string;
  gen: string;
}

export const USER_SNIPPETS_GROUP = 'Brew Snippets';
export const USER_SNIPPETS_ICON = 'fas fa-th-list';
/** Upstream's menu title for a brew without a title (snippetbar.jsx:152). */
export const UNTITLED_BREW = 'New Document';

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The stored user snippets (any accepted shape), flattened in order. */
export function parseUserSnippets(value: unknown, defaultGroup?: string): UserSnippet[] {
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    const json = brewSnippetsToJSON(defaultGroup ?? '', value, null, false);
    return json.snippets.flatMap((g) =>
      g.subsnippets.map((s) => ({ ...(defaultGroup !== undefined ? { group: defaultGroup } : {}), name: s.name, gen: s.gen })),
    );
  }
  if (!Array.isArray(value)) return [];
  const out: UserSnippet[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) continue;
    const name = str(entry.name)?.trim();
    if (Array.isArray(entry.subsnippets)) {
      for (const sub of entry.subsnippets as unknown[]) {
        if (!isRecord(sub)) continue;
        const subName = str(sub.name)?.trim();
        const gen = str(sub.gen);
        if (subName && gen !== null) out.push({ group: name || defaultGroup, name: subName, gen });
      }
      continue;
    }
    const gen = str(entry.gen);
    if (!name || gen === null) continue;
    const group = str(entry.group)?.trim() || defaultGroup;
    out.push(group !== undefined ? { group, name, gen } : { name, gen });
  }
  return out;
}

/** User snippets as submenus (one per group, in first-seen order). */
function toSubmenus(snippets: readonly UserSnippet[], fallbackGroup: string): ThemeSnippet[] {
  const groups = new Map<string, ThemeSnippet[]>();
  for (const s of snippets) {
    const group = s.group || fallbackGroup;
    const list = groups.get(group) ?? [];
    list.push({ name: s.name, icon: '', gen: s.gen });
    groups.set(group, list);
  }
  return [...groups].map(([name, subsnippets]) => ({ name, icon: '', subsnippets }));
}

/** A user theme's snippets as the theme bundle carries them ({ name, snippets }). */
export interface UserThemeSnippetsRef {
  name: string;
  snippets: unknown;
}

/**
 * The "Brew Snippets" group: one submenu per user theme with snippets (theme bundle order),
 * then the brew's own snippets under its title. Null when there are none.
 */
export function userSnippetGroup(
  brewTitle: string | null | undefined,
  brewSnippets: unknown,
  themeRefs: ReadonlyArray<string | UserThemeSnippetsRef> = [],
): ThemeSnippetGroup | null {
  const title = brewTitle?.trim() || UNTITLED_BREW;
  const submenus: ThemeSnippet[] = [];
  for (const ref of themeRefs) {
    if (typeof ref === 'string' || !isRecord(ref)) continue;
    const name = str(ref.name)?.trim() || 'Theme';
    const flat = parseUserSnippets(ref.snippets, name);
    // A theme's snippets all go under the theme's name (upstream: one submenu per theme).
    const subsnippets = flat.map((s) => ({ name: s.name, icon: '', gen: s.gen }));
    if (subsnippets.length) submenus.push({ name, icon: '', subsnippets });
  }
  submenus.push(...toSubmenus(parseUserSnippets(brewSnippets, title), title));
  if (!submenus.length) return null;
  return { groupName: USER_SNIPPETS_GROUP, icon: USER_SNIPPETS_ICON, view: 'text', snippets: submenus };
}
