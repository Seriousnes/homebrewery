// Snippets that became native editor features (plan §6.3): instead of inserting Homebrewery
// markdown, the Insert menu runs an editor command.
//
//   Table of Contents            → a live toc node (§6.5)
//   Footer / Footer from H1…H6   → the section's footer setting (upstream's footer.gen.js is broken)
//   Auto page numbers            → the section's page-number setting
//   Skip / restart numbering     → a marker on the current page
//   New Page                     → a manual page break
//
// Generators are recognised in two ways:
// - The generator modules that can't run outside upstream's editor (footer.gen.js reads the
//   CodeMirror text, tableOfContents.gen.js reads upstream's preview iframe) are replaced at
//   build time by the shims in ./shims (web/vite/themeSnippetShims.ts). Their generators carry
//   the action under NATIVE_SNIPPET and still return sensible markdown when called directly.
// - Plain markdown snippets whose whole text is one of NATIVE_MARKDOWN (theme or user snippets).
import type { ThemeSnippetGenerator } from './themeSnippets';

export type NativeSnippetAction =
  | { kind: 'toc' }
  /** The footer text comes from the last heading of `level` before the cursor. */
  | { kind: 'footer'; level: number }
  | { kind: 'pageNumber' }
  | { kind: 'marker'; marker: 'skipCounting' | 'resetCounting' }
  | { kind: 'pageBreak' };

/** Property of a shim generator that holds its NativeSnippetAction. */
export const NATIVE_SNIPPET = '__hbNativeSnippet';

/** A generator function tagged with a native action (for the shims). */
export type NativeGenerator = ((context?: unknown) => string) & { readonly __hbNativeSnippet: NativeSnippetAction };

/**
 * A generator that stands for `action`. Called like any generator it returns `fallback`
 * (markdown with a similar effect), so code that doesn't know native actions still works.
 */
export function nativeGenerator(action: NativeSnippetAction, fallback: string): NativeGenerator {
  const gen = () => fallback;
  Object.defineProperty(gen, NATIVE_SNIPPET, { value: action, enumerable: false });
  return gen as NativeGenerator;
}

/** Whole-snippet markdown (trimmed) that maps to a native action. */
export const NATIVE_MARKDOWN: ReadonlyMap<string, NativeSnippetAction> = new Map<string, NativeSnippetAction>([
  ['{{pageNumber,auto}}', { kind: 'pageNumber' }],
  ['{{pageNumber $[HB_pageNumber]}}', { kind: 'pageNumber' }],
  ['{{skipCounting}}', { kind: 'marker', marker: 'skipCounting' }],
  ['{{resetCounting}}', { kind: 'marker', marker: 'resetCounting' }],
  ['\\page', { kind: 'pageBreak' }],
]);

/** The native action a snippet generator stands for, or null for an ordinary markdown snippet. */
export function nativeActionOf(gen: ThemeSnippetGenerator | undefined): NativeSnippetAction | null {
  if (typeof gen === 'function') {
    const action = (gen as Partial<NativeGenerator>)[NATIVE_SNIPPET];
    return action ?? null;
  }
  if (typeof gen === 'string') return NATIVE_MARKDOWN.get(gen.trim()) ?? null;
  return null;
}

/** A short description of what a native action does (menu hints, announcements). */
export function describeNativeAction(action: NativeSnippetAction): string {
  switch (action.kind) {
    case 'toc':
      return 'Inserts a live table of contents';
    case 'footer':
      return `Sets the section footer from the last level ${action.level} heading`;
    case 'pageNumber':
      return 'Turns on page numbers for this section';
    case 'marker':
      return action.marker === 'skipCounting' ? 'This page does not advance the page count' : 'Page numbering restarts on this page';
    case 'pageBreak':
      return 'Starts a new page';
  }
}
