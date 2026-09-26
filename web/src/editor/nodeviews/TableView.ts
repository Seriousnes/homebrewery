// HbTableView: the editor's NodeView for `table`, emitting exactly Table.renderHTML's DOM
// (plan §3.2): table › [colgroup] › tbody.
//
// TipTap's Table registers its own TableView even without column resizing (@tiptap/extension-
// table 3.x, "keep colgroup in sync"), which wraps the table in div.tableWrapper and writes
// min-width styles. That breaks theme selectors that need the table itself in the flow:
// `.monster hr + table:first-of-type`, `h5 + table`, `div:not(.columnWrapper) > table + table`,
// and changes table widths. This view replaces it.
import { DOMSerializer, type Node as PMNode } from '@tiptap/pm/model';
import type { EditorView, NodeView, ViewMutationRecord } from '@tiptap/pm/view';

/** What the table's shell (its own attributes and the colgroup) depends on. */
function shellKey(node: PMNode): string {
  const widths: unknown[] = [];
  node.firstChild?.forEach((cell) => widths.push([cell.attrs.colspan, cell.attrs.colwidth]));
  return JSON.stringify([node.attrs, widths]);
}

export class HbTableView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private node: PMNode;
  private key: string;
  private readonly doc: Document;
  private attrNames = new Set<string>();

  constructor(node: PMNode, view?: EditorView) {
    this.node = node;
    this.doc = view?.dom.ownerDocument ?? document;
    const { dom, contentDOM } = this.render(node);
    this.dom = dom;
    this.contentDOM = contentDOM;
    for (const attr of Array.from(dom.attributes)) this.attrNames.add(attr.name);
    this.key = shellKey(node);
  }

  private render(node: PMNode): { dom: HTMLElement; contentDOM: HTMLElement } {
    const toDOM = node.type.spec.toDOM;
    if (!toDOM) throw new Error('HbTableView: the table node type has no toDOM');
    const { dom, contentDOM } = DOMSerializer.renderSpec(this.doc, toDOM(node));
    if (dom.nodeType !== 1 || !contentDOM) throw new Error('HbTableView: table renderHTML must have a content hole');
    return { dom, contentDOM };
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    const key = shellKey(node);
    if (key !== this.key) {
      const fresh = this.render(node).dom;
      // Own attributes (class, style, id, data-…): patch, keeping ones written by others.
      const next = new Set<string>();
      for (const attr of Array.from(fresh.attributes)) {
        next.add(attr.name);
        if (this.dom.getAttribute(attr.name) !== attr.value) this.dom.setAttribute(attr.name, attr.value);
      }
      for (const name of this.attrNames) if (!next.has(name)) this.dom.removeAttribute(name);
      this.attrNames = next;
      // colgroup: replaced as a whole (it only exists when a column has a pixel width).
      this.dom.querySelector(':scope > colgroup')?.remove();
      const colgroup = fresh.querySelector(':scope > colgroup');
      if (colgroup) this.dom.insertBefore(colgroup, this.dom.firstChild);
      this.key = key;
    }
    this.node = node;
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    if (mutation.target === this.contentDOM) return mutation.type === 'attributes';
    return !this.contentDOM.contains(mutation.target);
  }
}
