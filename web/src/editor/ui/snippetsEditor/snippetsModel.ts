// The brew snippets editor's list model (pure): snippets with local keys, their problems, and the
// grouping the Insert menu shows. See SnippetsEditorStore for edits and history.
import { hasSnippetHeaderLine } from '@/editor/snippets/snippetText';
import type { UserSnippetFields } from '@/editor/snippets/storedSnippets';

/** A brew snippet in the editor. `key` is local (list keys, selection), never stored. */
export interface EditableSnippet extends UserSnippetFields {
  readonly key: string;
}

/** Longest name or group the fields accept. */
export const MAX_SNIPPET_LABEL_LENGTH = 200;
/** The name "New snippet" gives a new snippet (numbered when taken). */
export const NEW_SNIPPET_NAME = 'New snippet';

export type SnippetIssueCode = 'nameRequired' | 'duplicateName' | 'separator' | 'emptyBody' | 'headerLine';

export interface SnippetIssue {
  code: SnippetIssueCode;
  field: 'name' | 'group' | 'gen';
  /** Errors are what the author should fix; warnings explain a consequence. */
  severity: 'error' | 'warning';
  message: string;
}

/** The Insert menu's submenu for a group ('' = the brew title's). */
export function groupLabel(group: string, brewTitle: string): string {
  return group.trim() || brewTitle;
}

/** Case- and accent-insensitive comparison key for names. */
const fold = (text: string): string => text.trim().normalize('NFKC').toLowerCase();

/**
 * The problems of every snippet (only snippets with problems have an entry). Two snippets clash
 * when the Insert menu would show them under the same submenu with the same name: an empty group
 * is the brew title's submenu.
 */
export function snippetIssues(snippets: readonly EditableSnippet[], brewTitle: string): Map<string, SnippetIssue[]> {
  const issues = new Map<string, SnippetIssue[]>();
  const add = (key: string, issue: SnippetIssue) => {
    const list = issues.get(key) ?? [];
    list.push(issue);
    issues.set(key, list);
  };
  const seen = new Map<string, number>();
  const idOf = (s: EditableSnippet) => `${fold(groupLabel(s.group, brewTitle))}\n${fold(s.name)}`;
  for (const s of snippets) if (s.name.trim()) seen.set(idOf(s), (seen.get(idOf(s)) ?? 0) + 1);
  for (const s of snippets) {
    const name = s.name.trim();
    if (!name) add(s.key, { code: 'nameRequired', field: 'name', severity: 'error', message: 'Give the snippet a name.' });
    else if ((seen.get(idOf(s)) ?? 0) > 1)
      add(s.key, {
        code: 'duplicateName',
        field: 'name',
        severity: 'error',
        message: `Another snippet in “${groupLabel(s.group, brewTitle)}” has this name.`,
      });
    if (name.includes('›')) add(s.key, { code: 'separator', field: 'name', severity: 'error', message: 'A name can’t contain “›” (it separates the group from the name).' });
    if (s.group.includes('›')) add(s.key, { code: 'separator', field: 'group', severity: 'error', message: 'A group can’t contain “›”.' });
    if (!s.gen.trim()) add(s.key, { code: 'emptyBody', field: 'gen', severity: 'warning', message: 'An empty snippet isn’t listed in the Insert menu.' });
    else if (hasSnippetHeaderLine(s.gen))
      add(s.key, {
        code: 'headerLine',
        field: 'gen',
        severity: 'warning',
        message: 'A line starts with “\\snippet ”: in exported text, a new snippet would start there.',
      });
  }
  return issues;
}

/** Number of snippets with at least one error. */
export function countErrors(issues: ReadonlyMap<string, readonly SnippetIssue[]>): number {
  let n = 0;
  for (const list of issues.values()) if (list.some((i) => i.severity === 'error')) n++;
  return n;
}

export interface SnippetGroupView {
  /** The stored group ('' = none). */
  group: string;
  /** What the Insert menu shows (the brew title for ''). */
  label: string;
  snippets: EditableSnippet[];
}

/**
 * The snippets by Insert-menu submenu, in the menu's order (first appearance), each in list
 * order. Snippets without a group and those whose group is the brew title share a submenu.
 */
export function groupSnippets(snippets: readonly EditableSnippet[], brewTitle: string): SnippetGroupView[] {
  const groups = new Map<string, SnippetGroupView>();
  for (const s of snippets) {
    const label = groupLabel(s.group, brewTitle);
    const view = groups.get(label) ?? { group: s.group.trim(), label, snippets: [] };
    view.snippets.push(s);
    groups.set(label, view);
  }
  return [...groups.values()];
}

/** The snippets in the order the list shows them (grouped). */
export function displayOrder(snippets: readonly EditableSnippet[], brewTitle: string): EditableSnippet[] {
  return groupSnippets(snippets, brewTitle).flatMap((g) => g.snippets);
}

/** `base`, or "base 2", "base 3", … : the first name no snippet of `group`'s submenu has. */
export function uniqueName(snippets: readonly EditableSnippet[], base: string, group: string, brewTitle: string): string {
  const label = fold(groupLabel(group, brewTitle));
  const taken = new Set(snippets.filter((s) => fold(groupLabel(s.group, brewTitle)) === label).map((s) => fold(s.name)));
  if (!taken.has(fold(base))) return base;
  for (let n = 2; ; n++) if (!taken.has(fold(`${base} ${n}`))) return `${base} ${n}`;
}

/** The distinct non-empty groups, in list order (suggestions for the Group field). */
export function groupNames(snippets: readonly EditableSnippet[]): string[] {
  return [...new Set(snippets.map((s) => s.group.trim()).filter(Boolean))];
}
