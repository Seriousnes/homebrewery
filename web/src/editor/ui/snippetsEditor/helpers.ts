// Small pure helpers of the snippets editor's components (kept out of the component files so
// that React Fast Refresh keeps working on them).
import type { ThemeSnippetRef } from '@/editor/canvas/themeLoader';
import { parseUserSnippets } from '@/editor/snippets/userSnippets';

/** Largest file the import reads (the snippets themselves can't exceed 2 MB of JSON anyway). */
export const MAX_IMPORT_FILE_BYTES = 8 * 1024 * 1024;

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A file name for the exported text: the brew title in lower case with dashes. */
export function exportFileName(brewTitle: string): string {
  const slug = brewTitle
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 60);
  return `${slug || 'brew'}-snippets.txt`;
}

export interface UserThemeSnippets {
  name: string;
  snippets: { name: string; gen: string }[];
}

/** The snippets of the user themes in a chain (static themes' snippets are the Insert menu's own). */
export function userThemeSnippets(refs: readonly ThemeSnippetRef[] | null | undefined): UserThemeSnippets[] {
  const out: UserThemeSnippets[] = [];
  for (const ref of refs ?? []) {
    if (typeof ref === 'string' || !ref || typeof ref !== 'object') continue;
    const name = (typeof ref.name === 'string' && ref.name.trim()) || 'Theme';
    const snippets = parseUserSnippets(ref.snippets, name).map((s) => ({ name: s.name, gen: s.gen }));
    if (snippets.length) out.push({ name, snippets });
  }
  return out;
}

/** "12 KB" / "1.5 MB" (the size of the stored snippets). */
export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
