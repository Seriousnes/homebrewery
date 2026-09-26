// NodeView of themeBlock (plan §6.4, P5.2). The element is exactly what renderHTML emits
// (div.block.<classes> with style, id and attributes) and it is also the contentDOM: its
// children are the block's content and nothing else, so theme selectors that count children
// (.monster hr ~ dl, :first-child, hr + table:first-of-type) match as they did upstream. The
// label and the wide/frame toggles are an overlay outside the canvas (overlay.ts). Attribute
// changes (a toggle, the inspector) patch the element in place instead of re-rendering the
// block's content.
import type { Node as PMNode } from '@tiptap/pm/model';
import type { NodeView, ViewMutationRecord } from '@tiptap/pm/view';

/** The attributes renderHTML gives the node (the CSS contract). */
export function renderedAttrs(node: PMNode): Record<string, string> {
  const spec = node.type.spec.toDOM?.(node);
  const attrs = Array.isArray(spec) ? (spec as unknown[])[1] : null;
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) || 'nodeType' in attrs) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs as Record<string, unknown>)) {
    if (value === null || value === undefined || value === false) continue;
    out[name] = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  }
  return out;
}

export class ThemeBlockNodeView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  node: PMNode;
  private attrs: Record<string, string>;

  constructor(node: PMNode) {
    this.node = node;
    this.dom = document.createElement('div');
    this.contentDOM = this.dom;
    this.attrs = {};
    this.patch(renderedAttrs(node));
  }

  private patch(next: Record<string, string>): void {
    for (const name of Object.keys(this.attrs)) if (!(name in next) && name !== 'class') this.dom.removeAttribute(name);
    for (const [name, value] of Object.entries(next)) if (name !== 'class' && this.attrs[name] !== value) this.dom.setAttribute(name, value);
    // The node's classes in renderHTML order, then any class that isn't ours (ProseMirror's
    // selected-node class, decoration classes).
    const oldClasses = (this.attrs.class ?? '').split(/\s+/).filter(Boolean);
    const newClasses = (next.class ?? '').split(/\s+/).filter(Boolean);
    const foreign = [...this.dom.classList].filter((cls) => !oldClasses.includes(cls) && !newClasses.includes(cls));
    const value = [...newClasses, ...foreign].join(' ');
    if (value) {
      if (this.dom.getAttribute('class') !== value) this.dom.setAttribute('class', value);
    } else this.dom.removeAttribute('class');
    this.attrs = next;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.patch(renderedAttrs(node));
    return true;
  }

  /** Attribute changes on the element itself are ours (patch); ProseMirror handles the content. */
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.type === 'attributes' && mutation.target === this.dom;
  }
}
