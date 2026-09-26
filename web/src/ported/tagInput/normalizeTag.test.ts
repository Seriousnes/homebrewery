import { describe, expect, it } from 'vitest';
import { filterOptions } from './comboboxModel';
import { MAX_TAGS, normalizeTag, TAG_PATTERN, tagProblem, tagType } from './normalizeTag';
import { TAG_CANONICAL_FORMS, TAG_SUGGESTIONS } from './tagSuggestions';

describe('TAG_PATTERN (upstream metadataEditor.jsx)', () => {
  it.each(['dragons', 'system:D&D 5e', 'type : Adventure', 'meta:theme', '5e', 'a/b\\c.d&e_f-g', `a${'b'.repeat(40)}`])('accepts %j', (tag) => {
    expect(TAG_PATTERN.test(tag)).toBe(true);
  });

  it.each(['', ' ', '-starts-with-dash', 'foo:bar', 'unknown: prefix', `a${'b'.repeat(41)}`, 'emoji 🐉', 'semi;colon'])('rejects %j', (tag) => {
    expect(TAG_PATTERN.test(tag)).toBe(false);
  });
});

describe('normalizeTag', () => {
  it('replaces known spellings with the canonical form, case-insensitively', () => {
    expect(normalizeTag('dnd')).toBe('D&D');
    expect(normalizeTag('DnD homebrew')).toBe('D&D homebrew');
    expect(normalizeTag('5th Edition')).toBe('5e');
    expect(normalizeTag('Dungeons and Dragons')).toBe('Dungeons & Dragons');
    expect(normalizeTag('pathfinder 2e')).toBe('P2e');
  });

  it('keeps an earlier group’s result (upstream turned 5.5e back into 5.5e)', () => {
    expect(normalizeTag('5.5e')).toBe('5e 2024');
    expect(normalizeTag("5e'24")).toBe('5e 2024');
  });

  it('applies several groups to one tag', () => {
    expect(normalizeTag('dnd 5th Edition')).toBe('D&D 5e');
  });

  it('tidies typed tags: lower-case type, no spaces around the colon, capitalised value', () => {
    expect(normalizeTag('System : dnd')).toBe('system:D&D');
    expect(normalizeTag('type:one-shot')).toBe('type:One-shot');
    expect(normalizeTag('META:theme')).toBe('meta:Theme');
  });

  it('keeps text after a second colon (curated suggestions contain one)', () => {
    expect(normalizeTag('system:Vampire: The Masquerade')).toBe('system:Vampire: The Masquerade');
  });

  it('leaves a type with an empty value alone', () => {
    expect(normalizeTag('system:')).toBe('system:');
  });

  it('accepts other canonical lists', () => {
    expect(normalizeTag('colour', [['color', 'colour']])).toBe('color');
  });
});

describe('tagType', () => {
  it('reads the prefix', () => {
    expect(tagType('system:D&D 5e')).toBe('system');
    expect(tagType(' Type : x')).toBe('type');
    expect(tagType('meta:theme')).toBe('meta');
    expect(tagType('group:Guild')).toBe('group');
    expect(tagType('dragons')).toBeNull();
    expect(tagType('other:thing')).toBeNull();
  });
});

describe('tagProblem', () => {
  it('rejects empty, malformed and duplicate tags (case-insensitive, after normalizing)', () => {
    expect(tagProblem('  ', [])).toMatch(/Enter a tag/);
    expect(tagProblem('bad;tag', [])).toMatch(/letter or digit/);
    expect(tagProblem('dnd', ['D&D'])).toMatch(/already/);
    expect(tagProblem('DRAGONS', ['dragons'])).toMatch(/already/);
    expect(tagProblem('dragons', ['elves'])).toBeNull();
  });

  it('enforces the server limit of 50 tags', () => {
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `tag${i}`);
    expect(tagProblem('one more', full)).toMatch(/at most 50/);
    // Editing a tag in place doesn't add one.
    expect(tagProblem('renamed', full, { ignoreIndex: 3 })).toBeNull();
  });

  it('ignores the edited tag itself when checking duplicates', () => {
    expect(tagProblem('Dragons', ['dragons', 'elves'], { ignoreIndex: 0 })).toBeNull();
    expect(tagProblem('Elves', ['dragons', 'elves'], { ignoreIndex: 0 })).toMatch(/already/);
  });

  it('skips the pattern for curated suggestions', () => {
    expect(tagProblem('system:Vampire: The Masquerade', [])).not.toBeNull();
    expect(tagProblem('system:Vampire: The Masquerade', [], { pattern: null })).toBeNull();
  });
});

describe('curated data', () => {
  it('is the upstream list', () => {
    expect(TAG_SUGGESTIONS.length).toBeGreaterThan(150);
    expect(TAG_SUGGESTIONS).toContain('system:D&D 5e');
    expect(new Set(TAG_SUGGESTIONS).size).toBe(TAG_SUGGESTIONS.length);
    expect(TAG_CANONICAL_FORMS.every((group) => group.length > 1)).toBe(true);
  });
});

describe('filterOptions', () => {
  const options = [
    { value: 'en', label: 'en', detail: 'English' },
    { value: 'de', label: 'de', detail: 'Deutsch', keywords: ['German'] },
    { value: 'system:Vampire: The Masquerade', label: 'system:Vampire: The Masquerade' },
  ];

  it('matches label, value, detail and keywords, case-insensitively', () => {
    expect(filterOptions(options, 'GERM').map((o) => o.value)).toEqual(['de']);
    expect(filterOptions(options, 'engl').map((o) => o.value)).toEqual(['en']);
  });

  it('startsWith matches word starts', () => {
    expect(filterOptions(options, 'the', 'startsWith').map((o) => o.value)).toEqual(['system:Vampire: The Masquerade']);
    expect(filterOptions(options, 'asque', 'startsWith')).toEqual([]);
    expect(filterOptions(options, 'asque', 'includes')).toHaveLength(1);
  });

  it('shows everything for empty text or filter none, capped at max', () => {
    expect(filterOptions(options, '')).toHaveLength(3);
    expect(filterOptions(options, 'zzz', 'none')).toHaveLength(3);
    expect(filterOptions(options, '', 'includes', 2)).toHaveLength(2);
  });
});
