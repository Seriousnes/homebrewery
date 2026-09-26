// Shared types of the save lane (plan §9, P3.8).
import type { JSONContent } from '@tiptap/core';
import type { BrewMetaInput } from '@/api';

/** The brew content a save sends, besides the version: what the editor and its panels hold. */
export interface BrewContent {
  /** ProseMirror JSON of the whole document (`editor.getJSON()`). */
  doc: JSONContent;
  /** User CSS. */
  style: string;
  /** User snippets (a JSON array) or null. */
  snippets: unknown;
  /** Metadata to send (null = keep the stored metadata). */
  meta: BrewMetaInput | null;
}

/**
 * What the server holds for the loaded brew (BrewForEdit's doc, style, snippets and meta), for the
 * "Restore unsaved changes" check. Only the fields given are compared.
 */
export interface BrewBaseline {
  doc: unknown;
  style?: string | null;
  snippets?: unknown;
  meta?: Partial<Record<keyof BrewMetaInput, unknown>> | null;
}
