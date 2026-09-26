import { describe, expect, it } from 'vitest';
import type { BrewForEdit } from '@/api';
import { BREW_FILE_FORMAT, brewFile, fileNameFor, pageCount, removeCopy, viewCount } from './brewItemModel';

describe('removeCopy', () => {
  it('deletes for good when the reader is the only author', () => {
    const copy = removeCopy({ title: 'My Brew', authors: ['alice'], role: 'owner' });
    expect(copy.label).toBe('Delete');
    expect(copy.title).toBe('Delete “My Brew”?');
    expect(copy.message).toMatch(/deleted for good/);
    expect(copy.confirmLabel).toBe('Delete brew');
    expect(copy.done(true)).toBe('“My Brew” was deleted.');
  });

  it('only removes the reader when other authors keep the brew', () => {
    const owner = removeCopy({ title: 'Shared', authors: ['alice', 'bob'], role: 'owner' });
    expect(owner.label).toBe('Remove');
    expect(owner.message).toMatch(/next author becomes its owner/);
    expect(owner.confirmLabel).toBe('Remove me');
    expect(owner.done(false)).toBe('You are no longer an author of “Shared”.');
    const author = removeCopy({ title: 'Shared', authors: ['alice', 'bob'], role: 'author' });
    expect(author.message).not.toMatch(/owner/);
  });

  it('declines an invitation', () => {
    const copy = removeCopy({ title: '', authors: ['bob'], role: 'invited' });
    expect(copy.label).toBe('Decline');
    expect(copy.title).toBe('Decline the invitation to “Untitled brew”?');
    expect(copy.done(false)).toBe('You declined the invitation to “Untitled brew”.');
  });
});

describe('counts', () => {
  it('pluralises', () => {
    expect(viewCount(1)).toBe('1 view');
    expect(viewCount(12345)).toBe('12,345 views');
    expect(pageCount(1)).toBe('1 page');
    expect(pageCount(0)).toBe('0 pages');
  });
});

describe('the brew file', () => {
  it('makes safe file names', () => {
    expect(fileNameFor('A/B: "C"?', 'json')).toBe('A B C.json');
    expect(fileNameFor('   ', 'json')).toBe('brew.json');
    expect(fileNameFor('..hidden..', 'json')).toBe('hidden.json');
    expect(fileNameFor('x'.repeat(200), 'md')).toBe(`${'x'.repeat(80)}.md`);
  });

  it('holds the stored brew', () => {
    const brew: BrewForEdit = {
      editId: 'edit1',
      shareId: 'share1',
      version: 4,
      docSchemaVersion: 1,
      doc: { type: 'doc', content: [] },
      style: '.page { color: red; }',
      snippets: null,
      sourceMarkdown: '# Imported',
      meta: { title: 'My Brew', description: 'd', tags: ['t'], lang: 'en', theme: '5ePHB', published: true, thumbnailUrl: null },
      authors: [
        { handle: 'alice', role: 'owner' },
        { handle: 'carol', role: 'invited' },
      ],
      role: 'owner',
      pageCount: 1,
      views: 3,
      lock: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    };
    const file = brewFile(brew, new Date('2026-09-25T10:00:00Z'));
    expect(file.name).toBe('My Brew.json');
    const json = JSON.parse(file.text) as Record<string, unknown>;
    expect(json).toMatchObject({
      format: BREW_FILE_FORMAT,
      formatVersion: 1,
      exportedAt: '2026-09-25T10:00:00.000Z',
      shareId: 'share1',
      docSchemaVersion: 1,
      version: 4,
      authors: ['alice'],
      style: '.page { color: red; }',
      snippets: null,
      doc: { type: 'doc', content: [] },
      sourceMarkdown: '# Imported',
    });
    expect(json).not.toHaveProperty('editId');
  });
});
