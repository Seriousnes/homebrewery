// Metadata model: upstream validation messages, the save payload and server error mapping, theme
// choices and language suggestions.
import { describe, expect, it } from 'vitest';
import { ApiError, type ThemeList } from '@/api';
import { languageOptions, LANG_CODES } from './languages';
import { canManageAuthors, draftFromBrew, metaFieldErrors, metaInputFromDraft, type MetadataBrew } from './metaDraft';
import { findThemeByText, themeChoices, themeLabel, themeOptions } from './themeOptions';
import { inviteProblem, normalizeHandle, parseShareReference, validateField } from './validations';

const context = { baseUrl: 'https://brew.example' };

describe('validateField (upstream validations.js messages)', () => {
  it('title: at most 100 characters', () => {
    expect(validateField('title', 'x'.repeat(100), context)).toEqual([]);
    expect(validateField('title', 'x'.repeat(101), context)).toEqual(['Max title length of 100 characters']);
  });

  it('description: at most 500 characters', () => {
    expect(validateField('description', 'x'.repeat(500), context)).toEqual([]);
    expect(validateField('description', 'x'.repeat(501), context)).toEqual(['Max description length of 500 characters.']);
  });

  it('thumbnail: empty, or an http(s) URL of at most 256 characters', () => {
    expect(validateField('thumbnailUrl', '', context)).toEqual([]);
    expect(validateField('thumbnailUrl', 'https://i.example/a.png', context)).toEqual([]);
    expect(validateField('thumbnailUrl', 'not a url', context)).toEqual(['Must be a valid URL']);
    // The server accepts only http(s) (upstream's new URL() let javascript: through).
    expect(validateField('thumbnailUrl', 'javascript:alert(1)', context)).toEqual(['Must be a valid URL']);
    const long = `https://i.example/${'a'.repeat(240)}`;
    expect(validateField('thumbnailUrl', long, context)).toEqual(['Max URL length of 256 characters.']);
  });

  it('lang: empty or a language code', () => {
    for (const ok of ['', 'en', 'pt-BR', 'zh-Hant', 'es-419', 'de-ch', 'sr-Latn-RS']) expect(validateField('lang', ok, context)).toEqual([]);
    for (const bad of ['e', 'english', 'en_US', 'en-']) expect(validateField('lang', bad, context)).toEqual(['Invalid language code.']);
  });

  it('theme: empty, a 12-character share id, or this site’s share URL', () => {
    expect(validateField('theme', '', context)).toEqual([]);
    expect(validateField('theme', 'abcDEF123_-x', context)).toEqual([]);
    expect(validateField('theme', 'https://brew.example/share/abcDEF123_-x', context)).toEqual([]);
    expect(validateField('theme', 'https://other.example/share/abcDEF123_-x', context)).toEqual(['Must be a valid Share URL or a 12-character ID.']);
    expect(validateField('theme', 'short', context)).toEqual(['Must be a valid Share URL or a 12-character ID.']);
  });
});

describe('parseShareReference', () => {
  it('extracts the id from an id or a share URL of this site', () => {
    expect(parseShareReference(' abcDEF123_-x ', 'https://brew.example')).toBe('abcDEF123_-x');
    expect(parseShareReference('https://brew.example/share/abcDEF123_-x/', 'https://brew.example/')).toBe('abcDEF123_-x');
    expect(parseShareReference('https://brew.example/edit/abcDEF123_-x', 'https://brew.example')).toBeNull();
    // The base is escaped, so '.' doesn't match any character.
    expect(parseShareReference('https://brewXexample/share/abcDEF123_-x', 'https://brew.example')).toBeNull();
  });
});

describe('invites', () => {
  it('normalizes and checks handles like the server', () => {
    expect(normalizeHandle('  Bob_1 ')).toBe('bob_1');
    expect(inviteProblem('Bob_1', [])).toBeNull();
    expect(inviteProblem('', [])).toMatch(/Enter a handle/);
    expect(inviteProblem('ab', [])).toMatch(/3 to 32/);
    expect(inviteProblem('has space', [])).toMatch(/3 to 32/);
    expect(inviteProblem('ALICE', ['alice'])).toMatch(/already on the author list/);
  });
});

const brew: MetadataBrew = {
  editId: 'edit00000001',
  shareId: 'share0000001',
  meta: { title: 'T', description: 'D', tags: ['a'], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: null },
  authors: [
    { handle: 'alice', role: 'owner' },
    { handle: 'bob', role: 'author' },
  ],
  role: 'owner',
  lock: null,
};

describe('draft and payload', () => {
  it('starts from the brew', () => {
    const draft = draftFromBrew(brew);
    expect(draft).toEqual({
      title: 'T',
      description: 'D',
      tags: ['a'],
      lang: 'en',
      theme: '5ePHB',
      published: false,
      thumbnailUrl: '',
      authors: brew.authors,
    });
    expect(draft.authors).not.toBe(brew.authors);
  });

  it('sends every field, and authors only when the owner changed the list', () => {
    const draft = draftFromBrew(brew);
    expect(metaInputFromDraft(draft, brew)).toEqual({ title: 'T', description: 'D', tags: ['a'], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: '' });
    const invited = { ...draft, authors: [...draft.authors, { handle: 'carol', role: 'invited' as const }] };
    expect(metaInputFromDraft(invited, brew).authors).toEqual(['alice', 'bob', 'carol']);
    // Non-owners never send the list (the server would answer 403).
    expect(metaInputFromDraft(invited, { ...brew, role: 'author' }).authors).toBeUndefined();
    // Reordering is a change too.
    const reordered = { ...draft, authors: [draft.authors[0]!, { handle: 'carol', role: 'invited' as const }] };
    expect(metaInputFromDraft(reordered, brew).authors).toEqual(['alice', 'carol']);
  });

  it('sends an empty thumbnail as "" (the server clears it) and trims it', () => {
    const draft = { ...draftFromBrew(brew), thumbnailUrl: '  https://i.example/a.png ' };
    expect(metaInputFromDraft(draft, brew).thumbnailUrl).toBe('https://i.example/a.png');
  });

  it('lets the owner, or the creator of an unsaved brew, manage authors', () => {
    expect(canManageAuthors('owner')).toBe(true);
    expect(canManageAuthors(null)).toBe(true);
    expect(canManageAuthors('author')).toBe(false);
    expect(canManageAuthors('invited')).toBe(false);
  });
});

describe('metaFieldErrors', () => {
  it('maps meta.* validation errors to fields and keeps the rest', () => {
    const error = ApiError.fromResponse(new Response(null, { status: 400 }), {
      title: 'One or more validation errors occurred.',
      errors: {
        'meta.title': ['must be at most 100 characters'],
        'meta.thumbnailUrl': ['must be an absolute http(s) URL of at most 256 characters'],
        'meta.authors': ["No user has the handle 'zed'.", "No user has the handle 'zoe'."],
        '$.meta.published': ['The JSON value could not be converted.'],
        'meta.other': ['odd'],
        'doc.content[0]': ['not a meta error'],
      },
    });
    const mapped = metaFieldErrors(error);
    expect(mapped.fields).toEqual({
      title: 'must be at most 100 characters',
      thumbnailUrl: 'must be an absolute http(s) URL of at most 256 characters',
      authors: "No user has the handle 'zed'. No user has the handle 'zoe'.",
      published: 'The JSON value could not be converted.',
    });
    expect(mapped.other).toEqual(['odd']);
  });

  it('is empty for anything that is not an ApiError', () => {
    expect(metaFieldErrors(new Error('x'))).toEqual({ fields: {}, other: [] });
    expect(metaFieldErrors(null)).toEqual({ fields: {}, other: [] });
  });
});

const list: ThemeList = {
  static: [
    { key: '5ePHB', name: '5e PHB', renderer: 'V3', baseTheme: 'Blank', baseSnippets: null, path: '5ePHB', style: '', scopedStyle: '', preview: null, texture: '/themes/V3/5ePHB/dropdownTexture.png', hasSnippets: true },
    { key: 'Blank', name: 'Blank', renderer: 'V3', baseTheme: null, baseSnippets: null, path: 'Blank', style: '', scopedStyle: '', preview: null, texture: null, hasSnippets: true },
  ],
  user: [
    { shareId: 'mineTheme001', name: 'My Parchment', author: 'alice', baseTheme: '5ePHB', thumbnailUrl: null, published: false, mine: true, updatedAt: '2026-09-01T00:00:00Z' },
    { shareId: 'share0000001', name: 'This brew', author: 'alice', baseTheme: '5ePHB', thumbnailUrl: null, published: true, mine: true, updatedAt: '2026-09-01T00:00:00Z' },
    { shareId: 'otherTheme01', name: 'Starry', author: 'dave', baseTheme: 'Blank', thumbnailUrl: 'https://i.example/s.png', published: true, mine: false, updatedAt: '2026-09-01T00:00:00Z' },
  ],
};

describe('theme choices', () => {
  it('lists static themes, then mine, then shared ones, without the brew itself', () => {
    const choices = themeChoices(list, { excludeShareId: 'share0000001' });
    expect(choices.map((c) => [c.id, c.group])).toEqual([
      ['5ePHB', 'static'],
      ['Blank', 'static'],
      ['mineTheme001', 'mine'],
      ['otherTheme01', 'shared'],
    ]);
    const options = themeOptions(choices);
    expect(options.map((o) => o.group)).toEqual(['Built-in themes', 'Built-in themes', 'My themes', 'Shared themes']);
    expect(options[3]).toMatchObject({ value: 'otherTheme01', label: 'Starry', detail: 'by dave', image: 'https://i.example/s.png' });
    expect(options[0]).toMatchObject({ value: '5ePHB', image: '/themes/V3/5ePHB/dropdownTexture.png' });
    expect(themeChoices(undefined)).toEqual([]);
  });

  it('labels the current theme and finds typed names', () => {
    const choices = themeChoices(list);
    expect(themeLabel('5ePHB', choices)).toBe('5e PHB');
    expect(themeLabel('mineTheme001', choices)).toBe('My Parchment (alice)');
    expect(themeLabel('unknownTheme', choices)).toBe('unknownTheme');
    expect(findThemeByText('blank', choices)?.id).toBe('Blank');
    expect(findThemeByText('my parchment (alice)', choices)?.id).toBe('mineTheme001');
    expect(findThemeByText('otherTheme01', choices)?.id).toBe('otherTheme01');
    expect(findThemeByText('nothing', choices)).toBeUndefined();
  });
});

describe('languageOptions', () => {
  it('offers upstream’s codes with their own names', () => {
    const options = languageOptions();
    expect(options.map((o) => o.value)).toEqual([...LANG_CODES]);
    expect(options.find((o) => o.value === 'de')).toMatchObject({ detail: 'Deutsch', keywords: ['German'] });
  });
});
