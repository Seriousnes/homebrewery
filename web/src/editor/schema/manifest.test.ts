// RV-15: the manifest gave only base types (number|null, string) for attributes that accept a few
// values, so the server could not reject page.columns 3, heading.level 7 or toc.depth 9, which the
// editor then renders and parses as something else. The constraints must match what the schema
// really keeps: every allowed value survives JSON → HTML → JSON, values outside don't.
import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { buildSchemaManifest } from './manifest';
import { docOf, docWith, fromHtml, node, p, page, schema, text, toHtml } from './testing';

const manifest = buildSchemaManifest(schema);

/** A minimal document holding one `type` node with `attrs`, and a reader for that node's attrs. */
function docFor(type: string, attrs: Record<string, unknown>): { doc: JSONContent; read: (doc: JSONContent) => Record<string, unknown> } {
  const firstBlock = (d: JSONContent) => d.content![0]!.content![0]!;
  switch (type) {
    case 'page':
      return { doc: docOf(page([p('x')], attrs)), read: (d) => d.content![0]!.attrs! };
    case 'heading':
      return { doc: docWith(node('heading', attrs, [text('H')])), read: (d) => firstBlock(d).attrs! };
    case 'paragraph':
      return { doc: docWith(p('x', attrs)), read: (d) => firstBlock(d).attrs! };
    case 'toc':
      return { doc: docWith(node('toc', attrs)), read: (d) => firstBlock(d).attrs! };
    case 'orderedList':
      return { doc: docWith(node('orderedList', attrs, [node('listItem', {}, [p('i')])])), read: (d) => firstBlock(d).attrs! };
    case 'tableCell':
    case 'tableHeader':
      return {
        doc: docWith(node('table', {}, [node('tableRow', {}, [node(type, attrs, [p('c')])])])),
        read: (d) => firstBlock(d).content![0]!.content![0]!.attrs!,
      };
    case 'image':
      return { doc: docWith(node('paragraph', {}, [node('image', { src: '/a.png', ...attrs })])), read: (d) => firstBlock(d).content![0]!.attrs! };
    default:
      throw new Error(`no test document for ${type}`);
  }
}

function roundTrip(type: string, attr: string, value: unknown): unknown {
  const { doc, read } = docFor(type, { [attr]: value });
  return read(fromHtml(toHtml(doc)))[attr];
}

describe('schema manifest: allowed values', () => {
  it('lists enums and ranges', () => {
    const attrs = (type: string, attr: string) => manifest.nodes[type]!.attrs[attr];
    expect(attrs('page', 'columns')).toMatchObject({ type: 'number|null', enum: [1, 2, null] });
    expect(attrs('page', 'kind')).toMatchObject({ enum: ['manual', 'auto'] });
    expect(attrs('heading', 'level')).toMatchObject({ enum: [1, 2, 3, 4, 5, 6] });
    expect(attrs('toc', 'depth')).toMatchObject({ enum: [1, 2, 3, 4, 5, 6] });
    expect(attrs('paragraph', 'align')).toMatchObject({ enum: ['left', 'right', 'center', 'justify', null] });
    expect(attrs('tableCell', 'align')).toMatchObject({ enum: ['left', 'right', 'center', null] });
    expect(attrs('tableHeader', 'align')).toMatchObject({ enum: ['left', 'right', 'center', null] });
    expect(attrs('tableCell', 'colspan')).toMatchObject({ integer: true, min: 1 });
    expect(attrs('tableHeader', 'rowspan')).toMatchObject({ integer: true, min: 1 });
    expect(attrs('orderedList', 'start')).toMatchObject({ integer: true });
    expect(attrs('image', 'width')).toMatchObject({ integer: true, min: 1 });
    // Unconstrained attributes carry none of the fields.
    expect(Object.keys(attrs('page', 'pid')!)).toEqual(['default', 'type']);
  });

  const constrained = Object.entries(manifest.nodes).flatMap(([type, n]) =>
    Object.entries(n.attrs)
      .filter(([, a]) => a.enum !== undefined)
      .map(([attr, a]) => [type, attr, a.enum!] as const),
  );

  it.each(constrained)('%s.%s: every allowed value survives an HTML round trip', (type, attr, values) => {
    for (const value of values) expect(roundTrip(type, attr, value), String(value)).toEqual(value);
  });

  it.each([
    ['page', 'columns', 3],
    ['page', 'kind', 'x'],
    ['heading', 'level', 7],
    ['toc', 'depth', 9],
    ['paragraph', 'align', 'middle'],
    ['tableCell', 'align', 'justify'],
  ] as const)('%s.%s = %j is outside the enum and does not survive', (type, attr, value) => {
    expect(manifest.nodes[type]!.attrs[attr]!.enum).not.toContain(value);
    expect(roundTrip(type, attr, value)).not.toEqual(value);
  });

  it.each([
    ['tableCell', 'colspan', 3],
    ['tableHeader', 'rowspan', 2],
    ['orderedList', 'start', 7],
    ['orderedList', 'start', 0],
    ['image', 'width', 640],
  ] as const)('%s.%s = %j is within the range and survives', (type, attr, value) => {
    expect(roundTrip(type, attr, value)).toEqual(value);
  });
});
