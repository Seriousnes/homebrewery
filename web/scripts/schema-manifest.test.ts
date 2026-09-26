/// <reference lib="dom" />
// Runs in the Vitest "node" project: proves the schema loads without a DOM (as the manifest
// script needs) and that the committed shared/schema-manifest.json matches the schema.
import { getSchema } from '@tiptap/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOC_SCHEMA_VERSION, schemaExtensions } from '../src/editor/schema';
import { buildSchemaManifest, serializeSchemaManifest, type SchemaManifest } from '../src/editor/schema/manifest';

const manifestFile = fileURLToPath(new URL('../../shared/schema-manifest.json', import.meta.url));

describe('schema manifest', () => {
  const manifest = buildSchemaManifest(getSchema(schemaExtensions));

  it('builds under Node without a DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(manifest.topNode).toBe('doc');
    expect(manifest.docSchemaVersion).toBe(DOC_SCHEMA_VERSION);
  });

  it('describes nodes with attrs, content, group, inline, atom and marks', () => {
    expect(manifest.nodes.doc).toMatchObject({ content: 'page+', children: ['page'] });
    expect(manifest.nodes.page).toMatchObject({ content: 'block+', group: null, inline: false, atom: false, allowsEmpty: false });
    expect(manifest.nodes.page?.attrs.pid).toEqual({ default: null, type: 'string|null' });
    expect(manifest.nodes.page?.attrs.objects).toEqual({ default: [], type: 'array', kind: 'pageObjects' });
    expect(manifest.nodes.page?.attrs.classes).toEqual({ default: [], type: 'array', kind: 'classes' });
    expect(manifest.nodes.paragraph).toMatchObject({ group: 'block', textblock: true, marks: '_' });
    expect(manifest.nodes.image).toMatchObject({ inline: true, atom: true, leaf: true, group: 'inline' });
    expect(manifest.nodes.image?.attrs.src).toEqual({ default: null, type: 'string|null', kind: 'url' });
    expect(manifest.nodes.rawHtml?.attrs.html).toEqual({ default: '', type: 'string', kind: 'html' });
    expect(manifest.nodes.codeBlock?.marks).toBe('');
    expect(manifest.nodes.themeBlock?.children).toContain('paragraph');
    expect(manifest.nodes.themeBlock?.children).not.toContain('page');
    expect(manifest.marks.span).toMatchObject({ excludes: '' });
    expect(manifest.marks.link?.attrs.href).toEqual({ default: null, type: 'string|null', kind: 'url' });
    expect(manifest.generic.safeAttributePattern).toBe('^(data-[\\w-]+|aria-[\\w-]+|title|lang|dir|role)$');
  });

  it('shared/schema-manifest.json is up to date (npm run schema)', () => {
    const committed = readFileSync(manifestFile, 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(serializeSchemaManifest(manifest));
    const parsed = JSON.parse(committed) as SchemaManifest;
    expect(Object.keys(parsed.nodes)).toContain('page');
  });
});
