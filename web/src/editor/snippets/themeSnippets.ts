// Shapes of the snippet arrays exported by themes/V3/*/snippets.js (plan §6.3).
// The generators are unchanged upstream code and return Homebrewery markdown.

/** What legacy's snippet bar passed to generator functions (snippetbar.jsx `execute`). */
export interface ThemeSnippetContext {
  brew?: { shareId?: string; title?: string; theme?: string; renderer?: string; text?: string };
  cursorPos?: unknown;
  [key: string]: unknown;
}

export type ThemeSnippetGenerator = string | ((context: ThemeSnippetContext) => string);

export interface ThemeSnippet {
  name: string;
  icon: string;
  gen?: ThemeSnippetGenerator;
  subsnippets?: ThemeSnippet[];
  experimental?: boolean;
  disabled?: boolean;
}

export interface ThemeSnippetGroup {
  groupName: string;
  icon: string;
  /** 'text' snippets insert into the document; 'style' snippets insert into the Style drawer. */
  view: 'text' | 'style';
  snippets: ThemeSnippet[];
}
