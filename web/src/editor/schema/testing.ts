// Test helpers for the schema (jsdom). Not used by the app.
import { elementFromString, getHTMLFromFragment, getSchema, type JSONContent } from '@tiptap/core';
import { DOMParser as PMDOMParser, Node as PMNode, type Schema } from '@tiptap/pm/model';
import { schemaExtensions } from './index';

export const schema: Schema = getSchema(schemaExtensions);

/** JSON with every attribute filled in (defaults), as the editor would store it. */
export function normalize(json: JSONContent): JSONContent {
  return PMNode.fromJSON(schema, json).toJSON() as JSONContent;
}

/** JSON → HTML, the way editor.getHTML() serializes (DOMSerializer via renderHTML). */
export function toHtml(json: JSONContent): string {
  return getHTMLFromFragment(PMNode.fromJSON(schema, json).content, schema);
}

/** HTML → JSON, the way generateJSON / insertContent parse (TipTap's elementFromString). */
export function fromHtml(html: string): JSONContent {
  return PMDOMParser.fromSchema(schema).parse(elementFromString(html)).toJSON() as JSONContent;
}

/** HTML → JSON with ProseMirror's parser on untouched DOM (the clipboard path). */
export function fromDom(html: string): JSONContent {
  const container = document.createElement('div');
  container.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(container).toJSON() as JSONContent;
}

/** A detached element holding `html`, for CSS-contract queries. */
export function dom(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

// Small JSON builders ---------------------------------------------------------------------------

export const text = (value: string, marks?: JSONContent['marks']): JSONContent =>
  marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };

export const node = (type: string, attrs?: Record<string, unknown>, content?: JSONContent[]): JSONContent => ({
  type,
  ...(attrs ? { attrs } : {}),
  ...(content ? { content } : {}),
});

export const p = (value: string, attrs?: Record<string, unknown>): JSONContent =>
  node('paragraph', attrs, value ? [text(value)] : undefined);

export const page = (content: JSONContent[], attrs?: Record<string, unknown>): JSONContent =>
  node('page', attrs, content);

export const docOf = (...pages: JSONContent[]): JSONContent => ({ type: 'doc', content: pages });

/** A one-page document holding `blocks`. */
export const docWith = (...blocks: JSONContent[]): JSONContent => docOf(page(blocks));
