// TypeScript port of the brew-text helpers in legacy/shared/helpers.js (plan §7, §10):
// splitTextStyleAndMetadata (helpers.js:88-115), yamlSnippetsToText (:77-86) and
// brewSnippetsToJSON (:6-75).
//
// A stored upstream brew is one text: an optional ```metadata YAML block, an optional ```css
// block, then the markdown. Upstream's "source" download writes both blocks in front of the text.
import { load } from 'js-yaml';

/** A user snippet as upstream's snippet bar stores it (brewSnippetsToJSON output). */
export interface BrewSnippet {
  name: string;
  icon?: string;
  gen: string;
}

export interface BrewSnippetGroup {
  name: string;
  icon?: string;
  gen?: string;
  subsnippets: BrewSnippet[];
}

export interface BrewSnippetsJSON {
  snippets: BrewSnippetGroup[];
  groupName?: string;
  icon?: string;
  view?: 'text';
}

/** Metadata fields upstream copies from the ```metadata block (helpers.js:92-103). */
export interface BrewMetadata {
  title?: string;
  description?: string;
  /** 'V3' or 'legacy'. Legacy-renderer brews can't be imported (plan §1). */
  renderer?: string;
  theme?: string;
  lang?: string;
  /** User snippets as `\snippet name` text (yamlSnippetsToText). */
  snippets?: string;
  bleedSize?: Record<string, unknown>;
  safetySpace?: Record<string, unknown>;
  trimSize?: Record<string, unknown>;
  columns?: unknown;
  columnGutter?: unknown;
  license?: unknown;
  legalAuthors?: unknown;
  tags?: string[];
}

export interface SplitBrew extends BrewMetadata {
  /** The markdown (metadata and CSS blocks removed, CRLF normalized to LF). */
  text: string;
  /** The brew's CSS (```css block), or undefined when there is none. */
  style?: string;
  /** Set when a ```metadata block was present but could not be parsed. */
  metadataError?: string;
}

/** The input: a brew text, optionally with fields already known (e.g. tags from an API). */
export interface BrewTextInput {
  text: string;
  tags?: unknown;
  [key: string]: unknown;
}

const BLOCK_END = '\n```\n\n';

type YamlSnippetGroup = { subsnippets?: Array<{ name?: unknown; gen?: unknown }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * User snippets from the metadata block as `\snippet name\n<gen>\n` text (helpers.js:77-86).
 * A string is returned unchanged.
 */
export function yamlSnippetsToText(yamlObj: unknown): string {
  if (typeof yamlObj === 'string') return yamlObj;
  if (!Array.isArray(yamlObj)) return '';
  let snippetsText = '';
  for (const snippet of yamlObj as YamlSnippetGroup[]) {
    for (const subSnippet of snippet?.subsnippets ?? []) {
      const gen = typeof subSnippet.gen === 'string' ? subSnippet.gen : '';
      snippetsText = `${snippetsText}\\snippet ${String(subSnippet.name)}\n${gen}\n`;
    }
  }
  return snippetsText;
}

const SNIPPET_SPLIT = /^(\\snippet +.+\n)/gm;

/** `\snippet name` sections of a snippet text, in order (helpers.js:13-24, 37-49). */
function parseSnippetText(text: string): BrewSnippet[] {
  const parts = text.trim().split(SNIPPET_SPLIT).slice(1);
  const snippets: BrewSnippet[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const head = parts[i] ?? '';
    if (!head.startsWith('\\snippet ')) break;
    const name = (head.split(/\\snippet +/)[1] ?? '').split('\n')[0]?.trim() ?? '';
    if (name.length !== 0) snippets.push({ name, gen: (parts[i + 1] ?? '').replace(/\n$/, '') });
  }
  return snippets;
}

/**
 * User snippets (and user-theme snippets) as snippet-bar groups (helpers.js:6-75).
 * `themeBundleSnippets` entries that are strings (static theme ids) are skipped, as upstream.
 */
export function brewSnippetsToJSON(
  menuTitle: string,
  userBrewSnippets: string | null | undefined,
  themeBundleSnippets: ReadonlyArray<string | { name: string; snippets: string }> | null = null,
  full = true,
): BrewSnippetsJSON {
  const groups: BrewSnippetGroup[] = [];
  for (const theme of themeBundleSnippets ?? []) {
    if (typeof theme === 'string') continue;
    const subsnippets = parseSnippetText(theme.snippets).map((s) => ({ ...s, icon: '' }));
    if (subsnippets.length > 0) groups.push({ name: theme.name, icon: '', gen: '', subsnippets });
  }
  if (userBrewSnippets) {
    const subsnippets = parseSnippetText(userBrewSnippets);
    if (subsnippets.length) groups.push({ name: menuTitle, subsnippets });
  }
  const result: BrewSnippetsJSON = { snippets: groups };
  if (full) {
    result.groupName = 'Brew Snippets';
    result.icon = 'fas fa-th-list';
    result.view = 'text';
  }
  return result;
}

const PICKED = ['title', 'description', 'renderer', 'theme', 'lang'] as const;

/**
 * Splits a brew text into metadata, CSS and markdown (helpers.js:88-115).
 *
 * Differences from upstream, all for untrusted input: a metadata or CSS block without its
 * closing fence is left in the text (upstream sliced garbage), YAML that fails to parse or
 * isn't a mapping sets `metadataError` instead of throwing, and only string values are copied
 * into the string fields.
 */
export function splitTextStyleAndMetadata(input: BrewTextInput): SplitBrew {
  let text = input.text.replaceAll('\r\n', '\n');
  const brew: SplitBrew = { text };

  if (text.startsWith('```metadata')) {
    const index = text.indexOf(BLOCK_END);
    if (index >= 0) {
      const section = text.slice(11, index + 1);
      let metadata: unknown;
      try {
        metadata = load(section);
      } catch (error) {
        brew.metadataError = error instanceof Error ? error.message : String(error);
      }
      if (metadata !== undefined && metadata !== null && !isRecord(metadata)) {
        brew.metadataError = 'The metadata block is not a YAML mapping.';
      }
      const meta = isRecord(metadata) ? metadata : {};
      for (const key of PICKED) {
        const value = meta[key];
        if (typeof value === 'string') brew[key] = value;
        else if (typeof value === 'number' || typeof value === 'boolean') brew[key] = String(value);
      }
      brew.snippets = yamlSnippetsToText(meta.snippets ?? '');
      brew.bleedSize = isRecord(meta.bleedSize) ? { ...meta.bleedSize } : {};
      brew.safetySpace = isRecord(meta.safetySpace) ? { ...meta.safetySpace } : {};
      brew.trimSize = isRecord(meta.trimSize) ? { ...meta.trimSize } : {};
      brew.columns = meta.columns;
      brew.columnGutter = meta.columnGutter;
      brew.license = meta.license;
      brew.legalAuthors = meta.legalAuthors;
      text = text.slice(index + BLOCK_END.length);
    }
  }
  if (text.startsWith('```css')) {
    const index = text.indexOf(BLOCK_END);
    if (index >= 0) {
      brew.style = text.slice(7, index + 1);
      text = text.slice(index + BLOCK_END.length);
    }
  }
  brew.text = text;

  // Old brews that still have an empty string in the tags metadata.
  const tags = input.tags;
  if (typeof tags === 'string') brew.tags = tags ? [tags] : [];
  else if (Array.isArray(tags)) brew.tags = tags.filter((t): t is string => typeof t === 'string');
  return brew;
}
