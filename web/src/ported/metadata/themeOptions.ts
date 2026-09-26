// Theme choices for the metadata dialog (upstream metadataEditor.jsx renderThemeDropdown): the
// static themes and the user themes of GET /api/themes, the caller's own ('mine') in their own
// group. A user theme is chosen by its share id (the value stored in meta.theme); a brew can't
// use itself as its theme.
import type { ThemeList } from '@/api';
import type { ComboboxOption } from '@/ported/tagInput/comboboxModel';

export type ThemeGroup = 'static' | 'mine' | 'shared';

export const THEME_GROUP_LABELS: Record<ThemeGroup, string> = {
  static: 'Built-in themes',
  mine: 'My themes',
  shared: 'Shared themes',
};

export interface ThemeChoice {
  /** meta.theme: a static key or a user theme's share id. */
  id: string;
  name: string;
  /** Owner handle of a user theme. */
  author: string | null;
  group: ThemeGroup;
  /** Small image for the list (static texture or user thumbnail). */
  image: string | null;
}

export function themeChoices(list: ThemeList | undefined, { excludeShareId }: { excludeShareId?: string | null } = {}): ThemeChoice[] {
  if (!list) return [];
  const choices: ThemeChoice[] = list.static.map((t) => ({ id: t.key, name: t.name, author: null, group: 'static', image: t.texture }));
  const user = list.user.filter((t) => t.shareId !== excludeShareId);
  for (const group of ['mine', 'shared'] as const) {
    for (const t of user) {
      if (t.mine !== (group === 'mine')) continue;
      choices.push({ id: t.shareId, name: t.name, author: t.author, group, image: t.thumbnailUrl });
    }
  }
  return choices;
}

export function themeOptions(choices: readonly ThemeChoice[]): ComboboxOption[] {
  return choices.map((c) => ({
    value: c.id,
    label: c.name,
    group: THEME_GROUP_LABELS[c.group],
    ...(c.author ? { detail: `by ${c.author}` } : {}),
    keywords: [c.id, ...(c.author ? [c.author] : [])],
    ...(c.image ? { image: c.image } : {}),
  }));
}

/** The text shown for the current theme: its name (with the author for user themes), else its id. */
export function themeLabel(themeId: string, choices: readonly ThemeChoice[]): string {
  const choice = choices.find((c) => c.id === themeId);
  if (!choice) return themeId;
  return choice.author ? `${choice.name} (${choice.author})` : choice.name;
}

/** A listed theme whose id, name or label is exactly `text` (case-insensitive for names). */
export function findThemeByText(text: string, choices: readonly ThemeChoice[]): ThemeChoice | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  return (
    choices.find((c) => c.id === t) ??
    choices.find((c) => themeLabel(c.id, choices).toLowerCase() === lower) ??
    choices.find((c) => c.name.toLowerCase() === lower)
  );
}
