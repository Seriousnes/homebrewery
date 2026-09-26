import { describe, expect, it } from 'vitest';
import type { BrewForEdit, BrewForShare } from '@/api';
import type { Draft } from '@/editor/save';
import {
  appBrewForNew,
  appBrewFromEdit,
  appBrewFromShare,
  baselineOf,
  blankDoc,
  defaultMeta,
  displayTitle,
  docForEditor,
  isOpenableVersion,
  isPrintShortcut,
  metaFromInput,
  UNTITLED,
} from './editorAppModel';

const meta = { title: 'Dragons', description: 'd', tags: ['a'], lang: 'fr', theme: 'Blank', published: true, thumbnailUrl: null };
const doc = { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }] };

const forEdit: BrewForEdit = {
  editId: 'edit1',
  shareId: 'share1',
  version: 4,
  docSchemaVersion: 1,
  doc,
  style: '.page { color: red }',
  snippets: [{ name: 'S', gen: 'x' }],
  sourceMarkdown: null,
  meta,
  authors: [{ handle: 'alice', role: 'owner' }],
  role: 'owner',
  pageCount: 1,
  views: 0,
  lock: { code: 455, message: 'Fix it', applied: '2026-09-01T00:00:00Z', reviewRequested: null },
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
};

describe('editorAppModel', () => {
  it('blankDoc is one page with an empty paragraph, a new object each time', () => {
    expect(blankDoc()).toEqual({ type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph' }] }] });
    expect(blankDoc()).not.toBe(blankDoc());
  });

  it('defaultMeta has the server defaults and takes overrides', () => {
    expect(defaultMeta()).toEqual({ title: '', description: '', tags: [], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: null });
    expect(defaultMeta({ theme: 'Blank' }).theme).toBe('Blank');
  });

  it('docForEditor migrates stored documents and replaces anything that is not one', () => {
    expect(docForEditor(doc, 1)).toBe(doc);
    expect(docForEditor(null, 1)).toEqual(blankDoc());
    expect(docForEditor({ type: 'page' }, 1)).toEqual(blankDoc());
    expect(() => docForEditor(doc, 99)).toThrow(RangeError);
  });

  it('opens documents of this schema version or older, never newer ones', () => {
    expect(isOpenableVersion(1)).toBe(true);
    expect(isOpenableVersion(2)).toBe(false);
    expect(isOpenableVersion(0)).toBe(false);
    expect(isOpenableVersion(1.5)).toBe(false);
  });

  it('maps BrewForEdit, BrewForShare and a /new draft', () => {
    const edit = appBrewFromEdit(forEdit);
    expect(edit).toMatchObject({ editId: 'edit1', shareId: 'share1', version: 4, role: 'owner', style: forEdit.style, snippets: forEdit.snippets });
    expect(edit.lock?.message).toBe('Fix it');
    expect(baselineOf(forEdit)).toEqual({ doc, style: forEdit.style, snippets: forEdit.snippets, meta });

    const share: BrewForShare = { shareId: 's', editId: null, docSchemaVersion: 1, doc, style: '', meta, authors: ['alice', 'bob'], pageCount: 1, views: 3, createdAt: '', updatedAt: '' };
    expect(appBrewFromShare(share)).toMatchObject({ editId: null, version: null, role: null, lock: null, authors: [{ handle: 'alice', role: 'owner' }, { handle: 'bob', role: 'author' }] });
    expect(appBrewFromShare({ ...share, editId: 'mine' }).editId).toBe('mine');

    expect(appBrewForNew(null)).toMatchObject({ editId: null, shareId: null, version: null, meta: defaultMeta(), style: '', snippets: null, authors: [] });
    const draft = { style: 'x', snippets: null, meta: { title: 'Draft title', theme: 'Journal' } } as Pick<Draft, 'style' | 'snippets' | 'meta'>;
    expect(appBrewForNew(draft).meta).toMatchObject({ title: 'Draft title', theme: 'Journal', lang: 'en' });
  });

  it('metaFromInput lays metadata edits over a base', () => {
    const base = defaultMeta({ thumbnailUrl: 'https://x/y.png' });
    expect(metaFromInput(null, base)).toBe(base);
    expect(metaFromInput({ tags: ['t'], thumbnailUrl: '' }, base)).toMatchObject({ tags: ['t'], thumbnailUrl: null, title: '' });
    expect(metaFromInput({ published: true }, base)).toMatchObject({ published: true, thumbnailUrl: 'https://x/y.png' });
  });

  it('displayTitle takes the first non-blank candidate', () => {
    expect(displayTitle('  ', null, 'Saved')).toBe('Saved');
    expect(displayTitle(' Mine ')).toBe('Mine');
    expect(displayTitle(undefined, '')).toBe(UNTITLED);
  });

  it('isPrintShortcut is Ctrl/Cmd+P without other modifiers', () => {
    const key = (init: Partial<{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }>) => ({
      key: 'p',
      code: 'KeyP',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    });
    expect(isPrintShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPrintShortcut(key({ metaKey: true, key: 'P' }))).toBe(true);
    expect(isPrintShortcut(key({ ctrlKey: true, key: 'з' }))).toBe(true); // Cyrillic layout, physical P
    expect(isPrintShortcut(key({}))).toBe(false);
    expect(isPrintShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPrintShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPrintShortcut(key({ ctrlKey: true, key: 'o', code: 'KeyO' }))).toBe(false);
    expect(isPrintShortcut(key({ ctrlKey: true, isComposing: true }))).toBe(false);
  });
});
