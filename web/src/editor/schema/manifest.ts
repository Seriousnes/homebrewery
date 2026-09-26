// shared/schema-manifest.json (plan §3.7): the schema described for the server, whose
// DocInspector validates every saved document against it. Pure: runs under Node.
import type { ContentMatch, NodeType, Schema } from '@tiptap/pm/model';
import { HB_ATTR_TYPES, RESERVED_ATTRS, RESERVED_CLASSES, SAFE_ATTR } from './attrs';
import { ICON_FONTS } from './nodes/inline';
import { PAGE_MARKERS } from './nodes/page';
import { DOC_SCHEMA_VERSION } from './version';

/** Manifest format version (bump when the JSON shape below changes). */
export const MANIFEST_VERSION = 1;

/**
 * What an attribute holds, for the server's checks:
 * - url: must not be javascript:/vbscript:/data: (image.src, link.href)
 * - html: sanitize with HtmlSanitizer (rawHtml.html)
 * - css: an inline style declaration list (no url(javascript:…), no expression())
 * - classes: string[] of class tokens
 * - attributes: Record<string,string>; keys match safeAttributePattern and are not reserved
 * - pageObjects: PageObject[] (src is a url, style is css, classes are classes)
 * - text: plain text
 */
export type AttributeKind = 'url' | 'html' | 'css' | 'classes' | 'attributes' | 'pageObjects' | 'text';

export interface AttributeManifest {
  default: unknown;
  /** "string", "number", "boolean", "null" joined by "|", or "array" / "object" / "any" */
  type: string;
  kind?: AttributeKind;
  /** The only values the schema keeps (other values change on the next HTML round trip). */
  enum?: unknown[];
  /** Numbers: whole numbers only. */
  integer?: boolean;
  /** Numbers: smallest value kept. */
  min?: number;
  /** Numbers: largest value kept. */
  max?: number;
}

/** The optional value constraints of an AttributeManifest. */
export type AttributeConstraints = Pick<AttributeManifest, 'enum' | 'integer' | 'min' | 'max'>;

export interface NodeManifest {
  attrs: Record<string, AttributeManifest>;
  /** ProseMirror content expression, or null for leaves */
  content: string | null;
  /** space-separated groups, or null */
  group: string | null;
  inline: boolean;
  atom: boolean;
  leaf: boolean;
  textblock: boolean;
  /** allowed marks: "_" = all, "" = none, else space-separated mark names */
  marks: string;
  /** every node type that may appear as a direct child (from the content expression) */
  children: string[];
  /** whether empty content is valid */
  allowsEmpty: boolean;
}

export interface MarkManifest {
  attrs: Record<string, AttributeManifest>;
  /** marks this one excludes: "" = none, "_" = all, else space-separated names */
  excludes: string;
  inclusive: boolean;
}

export interface SchemaManifest {
  version: number;
  docSchemaVersion: number;
  topNode: string;
  generic: {
    /** node types that carry classes/style/id/attributes */
    types: string[];
    safeAttributePattern: string;
    reservedAttributes: string[];
    reservedClasses: string[];
  };
  pageMarkers: string[];
  iconFonts: string[];
  nodes: Record<string, NodeManifest>;
  marks: Record<string, MarkManifest>;
}

/** Attribute kinds; "*" matches any node or mark type. */
const ATTR_KINDS: Record<string, AttributeKind> = {
  '*.classes': 'classes',
  '*.style': 'css',
  '*.attributes': 'attributes',
  'page.markers': 'classes',
  'page.objects': 'pageObjects',
  'page.footer': 'text',
  'image.src': 'url',
  'image.alt': 'text',
  'image.title': 'text',
  'link.href': 'url',
  'link.title': 'text',
  'rawHtml.html': 'html',
  'rawInline.html': 'html',
  'toc.title': 'text',
  'icon.font': 'classes',
  'icon.glyph': 'classes',
};

const LEVELS = [1, 2, 3, 4, 5, 6];
const CELL_ALIGN = { enum: ['left', 'right', 'center', null] };
const SPAN = { integer: true, min: 1 };

/**
 * Values the schema keeps for attributes that accept only some (plan §3.4: the schema is the single
 * source of truth for validation). manifest.test.ts checks them against the parse rules: every
 * listed value survives JSON → HTML → JSON.
 */
const ATTR_CONSTRAINTS: Record<string, AttributeConstraints> = {
  'page.kind': { enum: ['manual', 'auto'] },
  'page.columns': { enum: [1, 2, null] },
  'paragraph.align': { enum: ['left', 'right', 'center', 'justify', null] },
  'heading.level': { enum: LEVELS },
  'orderedList.start': { integer: true },
  'tableCell.align': CELL_ALIGN,
  'tableHeader.align': CELL_ALIGN,
  'tableCell.colspan': SPAN,
  'tableCell.rowspan': SPAN,
  'tableHeader.colspan': SPAN,
  'tableHeader.rowspan': SPAN,
  'toc.depth': { enum: LEVELS },
  'image.width': SPAN,
  'image.height': SPAN,
};

/** Types of attributes that come from TipTap without a `validate` type. */
const TYPE_HINTS: Record<string, string> = {
  'link.href': 'string|null',
  'link.target': 'string|null',
  'link.rel': 'string|null',
  'link.class': 'string|null',
  'link.title': 'string|null',
  'orderedList.type': 'string|null',
  'codeBlock.language': 'string|null',
  'tableCell.colwidth': 'array|null',
  'tableHeader.colwidth': 'array|null',
};

interface AttrSpecLike {
  default?: unknown;
  validate?: unknown;
}

function describeAttrs(typeName: string, attrs: Record<string, AttrSpecLike> | undefined): Record<string, AttributeManifest> {
  const out: Record<string, AttributeManifest> = {};
  for (const [name, spec] of Object.entries(attrs ?? {})) {
    const def = spec.default ?? null;
    const type =
      typeof spec.validate === 'string'
        ? spec.validate
        : (TYPE_HINTS[`${typeName}.${name}`] ??
          (Array.isArray(def) ? 'array' : def !== null && typeof def === 'object' ? 'object' : def === null ? 'any' : typeof def));
    const kind = ATTR_KINDS[`${typeName}.${name}`] ?? ATTR_KINDS[`*.${name}`];
    const constraints = ATTR_CONSTRAINTS[`${typeName}.${name}`];
    out[name] = { ...(kind ? { default: def, type, kind } : { default: def, type }), ...(constraints ? structuredClone(constraints) : {}) };
  }
  return out;
}

function allowedChildren(schema: Schema, type: NodeType): string[] {
  const names = new Set<string>();
  const seen = new Set<ContentMatch>();
  const walk = (match: ContentMatch) => {
    if (seen.has(match)) return;
    seen.add(match);
    for (let i = 0; i < match.edgeCount; i++) {
      const edge = match.edge(i);
      names.add(edge.type.name);
      walk(edge.next);
    }
  };
  walk(type.contentMatch);
  return Object.keys(schema.nodes).filter((n) => names.has(n));
}

export function buildSchemaManifest(schema: Schema): SchemaManifest {
  const nodes: Record<string, NodeManifest> = {};
  for (const [name, type] of Object.entries(schema.nodes)) {
    nodes[name] = {
      attrs: describeAttrs(name, type.spec.attrs),
      content: type.spec.content ?? null,
      group: type.spec.group ?? null,
      inline: type.isInline,
      atom: type.isAtom,
      leaf: type.isLeaf,
      textblock: type.isTextblock,
      marks: type.markSet === null ? '_' : type.markSet.map((m) => m.name).join(' '),
      children: allowedChildren(schema, type),
      allowsEmpty: type.contentMatch.validEnd,
    };
  }

  const marks: Record<string, MarkManifest> = {};
  for (const [name, type] of Object.entries(schema.marks)) {
    marks[name] = {
      attrs: describeAttrs(name, type.spec.attrs),
      excludes: type.spec.excludes ?? name,
      inclusive: type.spec.inclusive ?? true,
    };
  }

  return {
    version: MANIFEST_VERSION,
    docSchemaVersion: DOC_SCHEMA_VERSION,
    topNode: schema.topNodeType.name,
    generic: {
      types: [...HB_ATTR_TYPES],
      safeAttributePattern: SAFE_ATTR.source,
      reservedAttributes: [...RESERVED_ATTRS],
      reservedClasses: [...RESERVED_CLASSES],
    },
    pageMarkers: [...PAGE_MARKERS],
    iconFonts: [...ICON_FONTS],
    nodes,
    marks,
  };
}

/** The manifest file's exact text (stable key order, 2-space indent, trailing newline). */
export function serializeSchemaManifest(manifest: SchemaManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
