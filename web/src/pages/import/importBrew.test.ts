import { describe, expect, it } from 'vitest';
import { DOC_SCHEMA_VERSION } from '@/editor/schema/version';
import { cleanImportMeta, createBrewRequest, MAX_DESCRIPTION, MAX_TAGS, MAX_TITLE } from './importBrew';

describe('cleanImportMeta', () => {
  it('passes valid metadata through', () => {
    expect(cleanImportMeta({ title: ' My Brew ', description: 'About it', tags: ['5e', 'adventure'], lang: 'pt-BR', theme: '5eDMG' })).toEqual({
      meta: { title: 'My Brew', description: 'About it', tags: ['5e', 'adventure'], lang: 'pt-BR', theme: '5eDMG' },
      notes: [],
    });
  });

  it('fills in defaults', () => {
    expect(cleanImportMeta({ theme: '5ePHB' }).meta).toEqual({ title: '', description: '', tags: [], lang: 'en', theme: '5ePHB' });
  });

  it('shortens the title and description with notes', () => {
    const { meta, notes } = cleanImportMeta({ title: 'T'.repeat(150), description: 'D'.repeat(600), theme: '5ePHB' });
    expect(meta.title).toHaveLength(MAX_TITLE);
    expect(meta.description).toHaveLength(MAX_DESCRIPTION);
    expect(notes).toEqual([expect.stringMatching(/title was shortened/), expect.stringMatching(/description was shortened/)]);
  });

  it('never cuts a surrogate pair', () => {
    const title = `${'a'.repeat(MAX_TITLE - 1)}😀`;
    expect(cleanImportMeta({ title, theme: '5ePHB' }).meta.title).toBe('a'.repeat(MAX_TITLE - 1));
  });

  it('cleans tags', () => {
    const long = 'x'.repeat(101);
    const { meta, notes } = cleanImportMeta({ tags: [' a ', 'a', '', long, 'b'], theme: '5ePHB' });
    expect(meta.tags).toEqual(['a', 'b']);
    expect(notes).toEqual([expect.stringMatching(/1 tag was left out/)]);
    const many = cleanImportMeta({ tags: Array.from({ length: 60 }, (_, i) => `t${i}`), theme: '5ePHB' });
    expect(many.meta.tags).toHaveLength(MAX_TAGS);
    expect(many.notes).toEqual([expect.stringMatching(/first 50 of 60/)]);
  });

  it('replaces an invalid language and theme', () => {
    const { meta, notes } = cleanImportMeta({ lang: 'English', theme: 'bad theme!' });
    expect(meta.lang).toBe('en');
    expect(meta.theme).toBe('5ePHB');
    expect(notes).toEqual([expect.stringMatching(/“English” isn’t a language code/)]);
  });
});

describe('createBrewRequest', () => {
  const doc = { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph' }] }] };
  it('builds the POST body', () => {
    expect(createBrewRequest({ meta: { title: 'X' }, style: '.a{}', snippets: [{ name: 'S', gen: 'text' }] }, doc, '# Source')).toEqual({
      doc,
      style: '.a{}',
      snippets: [{ name: 'S', gen: 'text' }],
      meta: { title: 'X' },
      sourceMarkdown: '# Source',
      docSchemaVersion: DOC_SCHEMA_VERSION,
    });
  });

  it('sends no snippets when there are none', () => {
    expect(createBrewRequest({ meta: {}, style: '', snippets: [] }, doc, '').snippets).toBeNull();
    expect(createBrewRequest({ meta: {}, style: '', snippets: null }, doc, '').snippets).toBeNull();
  });
});
