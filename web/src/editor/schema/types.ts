// JSON shapes of stored documents (brews.doc). Attribute types mirror the schema; the
// generated shared/schema-manifest.json is the authoritative list for the server.
import type { JSONContent } from '@tiptap/core';
import type { HbGenericAttrs } from './attrs';
import type { PageAttrs } from './nodes/page';

export type NodeName =
  | 'doc'
  | 'page'
  | 'text'
  | 'paragraph'
  | 'heading'
  | 'bulletList'
  | 'orderedList'
  | 'listItem'
  | 'definitionList'
  | 'definitionTerm'
  | 'definitionDesc'
  | 'blockquote'
  | 'codeBlock'
  | 'horizontalRule'
  | 'table'
  | 'tableRow'
  | 'tableHeader'
  | 'tableCell'
  | 'themeBlock'
  | 'columnBreak'
  | 'spacer'
  | 'toc'
  | 'rawHtml'
  | 'rawInline'
  | 'image'
  | 'icon'
  | 'inlineBox'
  | 'hardBreak';

export type MarkName = 'span' | 'link' | 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'superscript' | 'subscript';

export interface ContinuationAttrs {
  continuation: boolean;
}

export interface ParagraphAttrs extends HbGenericAttrs, ContinuationAttrs {
  align: 'left' | 'right' | 'center' | 'justify' | null;
}

export interface HeadingAttrs extends HbGenericAttrs {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  /** true when `id` was chosen by the author; otherwise the headingIds plugin owns it */
  customId: boolean;
}

export interface OrderedListAttrs extends HbGenericAttrs, ContinuationAttrs {
  start: number;
  type: string | null;
}

export interface DefinitionListAttrs extends HbGenericAttrs, ContinuationAttrs {
  multiline: boolean;
}

export interface CodeBlockAttrs extends HbGenericAttrs {
  language: string | null;
}

export interface TableCellAttrs extends HbGenericAttrs {
  colspan: number;
  rowspan: number;
  colwidth: number[] | null;
  align: 'left' | 'right' | 'center' | null;
  width: string | null;
}

export interface ImageAttrs extends HbGenericAttrs {
  src: string | null;
  alt: string | null;
  title: string | null;
  width: number | null;
  height: number | null;
}

export interface IconAttrs {
  font: string;
  glyph: string;
}

export interface RawHtmlAttrs {
  html: string;
}

/** rawInline has the same attribute as rawHtml. */
export type RawInlineAttrs = RawHtmlAttrs;

export interface LinkAttrs {
  href: string | null;
  target: string | null;
  rel: string | null;
  class: string | null;
  title: string | null;
}

export type SpanAttrs = HbGenericAttrs;

/** A page node as stored. */
export interface PageJSON extends JSONContent {
  type: 'page';
  attrs?: Partial<PageAttrs>;
  content: JSONContent[];
}

/** A stored document: doc › page+. */
export interface DocJSON extends JSONContent {
  type: 'doc';
  content: PageJSON[];
}
