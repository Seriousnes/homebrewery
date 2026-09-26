// The brew an import creates (P6.1): POST /api/brews with the converted document, the brew CSS,
// the brew's own snippets, its metadata and the original text (brews.source_markdown). Upstream
// metadata is cleaned to what the API accepts (src/Homebrewery.Api/Brews/BrewRules.cs), and every
// change is reported as a note, so the create never fails on metadata the author can't see.
// Pure: no editor or conversion code here (the route chunk stays small).
import type { JSONContent } from '@tiptap/core';
import type { BrewMetaInput, CreateBrewRequest } from '@/api';
import { DOC_SCHEMA_VERSION } from '@/editor/schema/version';

/** BrewRules limits. */
export const MAX_TITLE = 100;
export const MAX_DESCRIPTION = 500;
export const MAX_TAGS = 50;
export const MAX_TAG = 100;
export const DEFAULT_IMPORT_LANG = 'en';

/** Upstream's language rule, as the API checks it (BrewRules.Lang). */
const LANG = /^[a-zA-Z]{2,3}(-[a-zA-Z]{4})?(-(?:[0-9]{3}|[a-zA-Z]{2}))?$/;
/** A theme key or user theme id, as the API checks it (BrewRules.Theme). */
const THEME = /^[A-Za-z0-9_-]{1,64}$/;

/** A user snippet in the stored shape (plan §8.2 `[{ group, name, gen }]`; group omitted = the brew title, as upstream). */
export interface StoredSnippet {
  name: string;
  gen: string;
}

/** What the import found in the brew's ```metadata block (and the theme it was laid out with). */
export interface ImportedMetadata {
  title?: string;
  description?: string;
  tags?: readonly string[];
  lang?: string;
  /** The theme the import used (already checked to exist). */
  theme: string;
}

export interface CleanedMeta {
  meta: BrewMetaInput;
  /** What was changed to fit the API's rules, in words. */
  notes: string[];
}

/** At most `max` UTF-16 units (what the API counts), never cutting a surrogate pair in half. */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/** The metadata to send: trimmed, shortened to the API's limits, invalid values replaced. */
export function cleanImportMeta(input: ImportedMetadata): CleanedMeta {
  const notes: string[] = [];
  const title = (input.title ?? '').trim();
  const description = (input.description ?? '').trim();
  const meta: BrewMetaInput = { title: shorten(title, MAX_TITLE), description: shorten(description, MAX_DESCRIPTION) };
  if (meta.title !== title) notes.push(`The title was shortened to ${MAX_TITLE} characters.`);
  if (meta.description !== description) notes.push(`The description was shortened to ${MAX_DESCRIPTION} characters.`);

  const tags: string[] = [];
  let longTags = 0;
  for (const raw of input.tags ?? []) {
    const tag = raw.trim();
    if (!tag || tags.includes(tag)) continue;
    if (tag.length > MAX_TAG) longTags++;
    else tags.push(tag);
  }
  if (longTags) notes.push(`${longTags} ${longTags === 1 ? 'tag was' : 'tags were'} left out for being longer than ${MAX_TAG} characters.`);
  if (tags.length > MAX_TAGS) notes.push(`Only the first ${MAX_TAGS} of ${tags.length} tags were kept.`);
  meta.tags = tags.slice(0, MAX_TAGS);

  const lang = (input.lang ?? '').trim();
  if (lang && !LANG.test(lang)) notes.push(`The language “${shorten(lang, 40)}” isn’t a language code; English (en) is used.`);
  meta.lang = lang && LANG.test(lang) ? lang : DEFAULT_IMPORT_LANG;
  meta.theme = THEME.test(input.theme) ? input.theme : '5ePHB';
  return { meta, notes };
}

export interface ImportToCreate {
  meta: BrewMetaInput;
  style: string;
  snippets: StoredSnippet[] | null;
}

/**
 * The create request: `doc` is the paginated document from the preview when it has settled (the
 * brew opens already laid out, and its page count is right from the start), else the import's own
 * one-manual-page-per-source-page document. `source` is the text as imported.
 */
export function createBrewRequest(imported: ImportToCreate, doc: JSONContent, source: string): CreateBrewRequest {
  return {
    doc,
    style: imported.style,
    snippets: imported.snippets && imported.snippets.length ? imported.snippets : null,
    meta: imported.meta,
    sourceMarkdown: source,
    docSchemaVersion: DOC_SCHEMA_VERSION,
  };
}
