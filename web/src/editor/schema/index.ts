// The editor schema: the single source of truth for documents (plan §3).
//
// Rules for this folder:
// - No DOM access at import time and no NodeViews: the schema also runs under Node
//   (web/scripts/schema-manifest.ts writes shared/schema-manifest.json, which the server's
//   DocInspector validates every save against).
// - Relative imports only (no '@/…' alias): the manifest script is compiled and run outside Vite.
// - Changing a node/mark/attribute changes the manifest: run `pnpm run schema` and commit
//   shared/schema-manifest.json. Incompatible changes bump DOC_SCHEMA_VERSION + a migration.
//
// Editor behaviour (heading ids, page ids, history, cursors, NodeViews, pagination) is added on
// top by web/src/editor/editorExtensions.ts.
import type { AnyExtension } from '@tiptap/core';
import type { LinkOptions } from '@tiptap/extension-link';
import { HbAttributes } from './attrs';
import { createHbLink, HbBold, HbCode, HbItalic, HbStrike, HbSubscript, HbSuperscript, HbUnderline, Span } from './marks';
import { ColumnBreak, RawHtml, Spacer, ThemeBlock, Toc } from './nodes/blocks';
import { HbImage, Icon, InlineBox, RawInline } from './nodes/inline';
import { DefinitionDesc, DefinitionList, DefinitionTerm, HbBulletList, HbListItem, HbOrderedList } from './nodes/lists';
import { HbDocument, HbText, Page } from './nodes/page';
import { HbTable, HbTableCell, HbTableHeader, HbTableRow } from './nodes/table';
import {
  HbBlockquote,
  HbCodeBlock,
  HbHardBreak,
  HbHeading,
  HbHorizontalRule,
  HbParagraph,
} from './nodes/textBlocks';

export { DOC_SCHEMA_VERSION } from './version';
export { migrateDoc, type DocMigration } from './migrations';

export interface SchemaExtensionOptions {
  /** Link behaviour (openOnClick, autolink, …). Doesn't change the schema. */
  link?: Partial<LinkOptions>;
}

/**
 * The schema extensions, in schema order (paragraph comes first, so it is the default block).
 * Pass options only for editor behaviour that doesn't change the schema.
 */
export function createSchemaExtensions(options: SchemaExtensionOptions = {}): AnyExtension[] {
  return [
    // nodes
    HbDocument,
    Page,
    HbText,
    HbParagraph,
    HbHeading,
    HbBulletList,
    HbOrderedList,
    HbListItem,
    DefinitionList,
    DefinitionTerm,
    DefinitionDesc,
    HbBlockquote,
    HbCodeBlock,
    HbHorizontalRule,
    HbTable,
    HbTableRow,
    HbTableHeader,
    HbTableCell,
    ThemeBlock,
    ColumnBreak,
    Spacer,
    Toc,
    RawHtml,
    HbImage,
    Icon,
    RawInline,
    InlineBox,
    HbHardBreak,
    // marks
    Span,
    createHbLink(options.link),
    HbBold,
    HbItalic,
    HbUnderline,
    HbStrike,
    HbCode,
    HbSuperscript,
    HbSubscript,
    // generic classes/style/id/attributes (plan §3.5)
    HbAttributes,
  ];
}

/** Schema-only extensions: used by getSchema, generateJSON/generateHTML and the manifest. */
export const schemaExtensions: AnyExtension[] = createSchemaExtensions();

// Node and mark extensions, for NodeViews (`Page.extend({ addNodeView… })`) and commands.
export {
  ColumnBreak,
  DefinitionDesc,
  DefinitionList,
  DefinitionTerm,
  HbAttributes,
  HbBlockquote,
  HbBold,
  HbBulletList,
  HbCode,
  HbCodeBlock,
  HbDocument,
  HbHardBreak,
  HbHeading,
  HbHorizontalRule,
  HbImage,
  HbItalic,
  HbListItem,
  HbOrderedList,
  HbParagraph,
  HbStrike,
  HbSubscript,
  HbSuperscript,
  HbTable,
  HbTableCell,
  HbTableHeader,
  HbTableRow,
  HbText,
  HbUnderline,
  Icon,
  InlineBox,
  Page,
  RawHtml,
  RawInline,
  Spacer,
  Span,
  ThemeBlock,
  Toc,
  createHbLink,
};

// Constants and helpers
export {
  HB_ATTR_TYPES,
  RESERVED_ATTRS,
  RESERVED_CLASSES,
  SAFE_ATTR,
  cleanAttributes,
  cleanClasses,
  isAllowedAttribute,
  type HbAttrType,
  type HbGenericAttrs,
} from './attrs';
export { PAGE_MARKERS, SECTION_ATTRS, normalizeMarkers, normalizePageObjects, pageChromeSpec, pageClass } from './nodes/page';
export type { PageAttrs, PageKind, PageMarker, PageObject } from './nodes/page';
export { RAW_HTML_TAGS, type TocAttrs } from './nodes/blocks';
export { markMultilineDefinitionLists } from './nodes/lists';
export { ICON_FONTS, RAW_INLINE_TAGS, type IconFont } from './nodes/inline';
export type { ParagraphAlign } from './nodes/textBlocks';
export type { CellAlign } from './nodes/table';
export { hbSrcDeclaration, isSafeHref, isSafeSrc, isSafeUrl, sanitizeRawHtml, stripHbSrc, urlScheme } from './html';
export { normalizeStyle, parseStyle } from './attrs';
export { HeadingSlugger, headingSlugSource, slugify } from './slug';
export { LINK_DEFAULTS } from './marks';
export type * from './types';
