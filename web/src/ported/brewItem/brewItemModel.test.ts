import { describe, expect, it } from 'vitest';
import { pageCount, removeCopy, viewCount } from './brewItemModel';

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
