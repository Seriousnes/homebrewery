// The source view: the document's HTML (what the schema's renderHTML emits, plan §3.2), printed
// for people to read and edit.
//
//   - one block per line, containers (pages, lists, items, quotes, theme blocks, tables, rows,
//     cells) indented with their children on the lines below; a list item or cell that holds a
//     single text block stays on one line;
//   - text blocks, atoms, code blocks, definition lists and raw HTML on one line each (a code
//     block keeps its own line breaks; raw HTML is printed exactly as stored);
//   - a section is its first page's element, <div class="page" …>, holding the whole flow of the
//     section: auto pages and the fragments pagination split a block into never appear;
//   - machine noise is left out: page ids and kinds, the page chrome and div.columnWrapper
//     (both come from the page's data-* attributes), generated heading ids (only ids an author
//     chose are shown), img[loading] and the --HB_src declaration, the table's colgroup and tbody.
//     parse.ts restores them.
import { DOMSerializer, type DOMOutputSpec, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { stripHbSrc } from '../schema/html';
import type { FlowItem, Section } from './flow';

const INDENT = '  ';
/** Attributes of a page element that are layout state, not content. */
const PAGE_NOISE = ['data-pid', 'data-kind'];
/** Nodes printed with their children on the lines below (the others are one line). */
const CONTAINERS = new Set(['page', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableHeader', 'tableCell', 'themeBlock']);
/** Containers that stay on one line when they hold a single text block. */
const COMPACT = new Set(['listItem', 'tableHeader', 'tableCell']);

type Attrs = Record<string, unknown>;
type SpecFn = (node: PMNode) => DOMOutputSpec;

/** `spec` with its attribute object changed by `edit` (specs without one are returned as is). */
function editAttrs(spec: DOMOutputSpec, edit: (attrs: Attrs) => void): DOMOutputSpec {
  if (!Array.isArray(spec)) return spec;
  const attrs = spec[1] as unknown;
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs) || 'nodeType' in attrs) return spec;
  const copy: Attrs = { ...(attrs as Attrs) };
  edit(copy);
  const out = [...(spec as unknown[])];
  out[1] = copy;
  return out as unknown as DOMOutputSpec;
}

/** The schema's serializer with the source view's noise left out. */
export function sourceSerializer(schema: Schema): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  const nodes: Record<string, SpecFn> = { ...base.nodes };
  const wrap = (name: string, edit: (attrs: Attrs, node: PMNode) => void) => {
    const render = base.nodes[name];
    if (render) nodes[name] = (node) => editAttrs(render(node), (attrs) => edit(attrs, node));
  };
  wrap('heading', (attrs, node) => {
    delete attrs['data-custom-id'];
    if (node.attrs.customId !== true) delete attrs.id;
  });
  wrap('image', (attrs) => {
    delete attrs.loading;
    const style = typeof attrs.style === 'string' ? stripHbSrc(attrs.style) : null;
    if (style) attrs.style = style;
    else delete attrs.style;
  });
  wrap('page', (attrs) => {
    for (const name of PAGE_NOISE) delete attrs[name];
  });
  return new DOMSerializer(nodes, base.marks);
}

/** An inert document to build the DOM in (nothing in it loads). */
function inertDocument(): Document {
  return document.implementation.createHTMLDocument('');
}

export class SourcePrinter {
  private readonly serializer: DOMSerializer;
  private readonly doc: Document;

  constructor(schema: Schema) {
    this.serializer = sourceSerializer(schema);
    this.doc = inertDocument();
  }

  /** One block (and its children) as lines at `depth`. */
  printBlock(node: PMNode, depth: number, out: string[]): void {
    const indent = INDENT.repeat(depth);
    const container = CONTAINERS.has(node.type.name) && !(COMPACT.has(node.type.name) && node.childCount === 1 && node.firstChild!.isTextblock);
    if (!container) {
      const dom = this.serializer.serializeNode(node, { document: this.doc });
      out.push(indent + outerHtml(dom));
      return;
    }
    const render = this.serializer.nodes[node.type.name]!;
    const { dom } = DOMSerializer.renderSpec(this.doc, render(node));
    const [open, close] = tags(dom);
    out.push(indent + open);
    node.forEach((child) => this.printBlock(child, depth + 1, out));
    out.push(indent + close);
  }

  /** A run of blocks (the selection scope), one per line. */
  printBlocks(nodes: readonly PMNode[]): string {
    const out: string[] = [];
    for (const node of nodes) this.printBlock(node, 0, out);
    return out.join('\n');
  }

  /** One section: its first page's element around the merged flow. */
  printSection(section: Pick<Section, 'page'> & { items: readonly Pick<FlowItem, 'node'>[] }, out: string[]): void {
    const render = this.serializer.nodes.page!;
    const { dom } = DOMSerializer.renderSpec(this.doc, render(section.page));
    const [open, close] = tags(dom);
    out.push(open);
    for (const item of section.items) this.printBlock(item.node, 1, out);
    out.push(close);
  }

  /** Sections, separated by an empty line. */
  printSections(sections: readonly (Pick<Section, 'page'> & { items: readonly Pick<FlowItem, 'node'>[] })[]): string {
    const out: string[] = [];
    sections.forEach((section, i) => {
      if (i > 0) out.push('');
      this.printSection(section, out);
    });
    return out.join('\n');
  }
}

function outerHtml(node: globalThis.Node): string {
  if (node.nodeType === 1) return (node as Element).outerHTML;
  const holder = node.ownerDocument!.createElement('div');
  holder.append(node);
  return holder.innerHTML;
}

/** The start and end tags of an element (its children left out). */
function tags(el: Element): [string, string] {
  const shell = el.cloneNode(false) as Element;
  const html = shell.outerHTML;
  const close = `</${shell.localName}>`;
  return [html.endsWith(close) ? html.slice(0, -close.length) : html, close];
}
