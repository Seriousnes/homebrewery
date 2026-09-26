// Type declarations for the untyped JavaScript under the repository's themes/ directory,
// imported through the @themes alias. allowJs is off, so TypeScript only sees these shapes.

declare module '@themes/V3/*/snippets.js' {
  import type { ThemeSnippetGroup } from '@/editor/snippets/themeSnippets';

  const snippetGroups: ThemeSnippetGroup[];
  export default snippetGroups;
}

declare module '@themes/V3/*.gen.js' {
  // Generator modules export a function or an object of named generator functions.
  const generator: unknown;
  export default generator;
}

declare module '@themes/fonts/iconFonts/*.js' {
  /** Icon name (as typed after ':' in markdown, e.g. "df_d12_2") → CSS classes ("df d12-2"). */
  const icons: Record<string, string>;
  export default icons;
}

declare module '@themes/codeMirror/*.js' {
  import type { Extension } from '@codemirror/state';

  const theme: Extension;
  export default theme;
}
