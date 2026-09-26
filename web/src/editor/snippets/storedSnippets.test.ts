import { describe, expect, it } from 'vitest';
import { editableUserSnippets, jsonStringLength, MAX_SNIPPETS_JSON, serverJsonLength, snippetsFit, storedSnippets } from './storedSnippets';
import { parseUserSnippets } from './userSnippets';

describe('storedSnippets', () => {
  it('writes the flat form: trimmed, group only when set, null for none', () => {
    expect(
      storedSnippets([
        { group: ' Tables ', name: ' Loot ', gen: '|a|\n' },
        { group: '', name: 'Loose', gen: '' },
      ]),
    ).toEqual([
      { group: 'Tables', name: 'Loot', gen: '|a|\n' },
      { name: 'Loose', gen: '' },
    ]);
    expect(storedSnippets([])).toBeNull();
  });

  it('is read back by the Insert menu (parseUserSnippets) and by the editor', () => {
    const stored = storedSnippets([
      { group: 'G', name: 'A', gen: 'a' },
      { group: '', name: 'B', gen: 'b' },
    ]);
    expect(parseUserSnippets(stored, 'Title')).toEqual([
      { group: 'G', name: 'A', gen: 'a' },
      { group: 'Title', name: 'B', gen: 'b' },
    ]);
    expect(editableUserSnippets(stored)).toEqual([
      { group: 'G', name: 'A', gen: 'a' },
      { group: '', name: 'B', gen: 'b' },
    ]);
  });
});

describe('editableUserSnippets', () => {
  it('keeps flat entries without a name or body (saved mid-edit)', () => {
    expect(editableUserSnippets([{ name: '', gen: 'body' }, { name: 'No body' }, { group: 5, name: 'X', gen: 'x' }, {}, 'junk', null])).toEqual([
      { group: '', name: '', gen: 'body' },
      { group: '', name: 'No body', gen: '' },
      { group: '', name: 'X', gen: 'x' },
    ]);
  });

  it("reads upstream's stored form and the text form", () => {
    expect(editableUserSnippets([{ name: 'Old Title', subsnippets: [{ name: 'One', gen: '1' }] }, { name: 'Flat', gen: 'f' }])).toEqual([
      { group: 'Old Title', name: 'One', gen: '1' },
      { group: '', name: 'Flat', gen: 'f' },
    ]);
    expect(editableUserSnippets('\\snippet A\nbody\n')).toEqual([{ group: '', name: 'A', gen: 'body' }]);
    expect(editableUserSnippets(null)).toEqual([]);
    expect(editableUserSnippets({ name: 'not an array' })).toEqual([]);
  });
});

describe('serverJsonLength', () => {
  // Expected values printed by System.Text.Json (JsonNode.ToJsonString()) for the same input.
  it('matches the server for escapes, non-ASCII and HTML-sensitive characters', () => {
    const u = (...codes: number[]) => String.fromCharCode(...codes);
    const value = [{ group: 'G', name: 'a<b>&\'"+`/x', gen: `${u(0xe9, 0xd83d, 0xde00)}\n\t${u(0x01, 0x7f, 0x2028)} ~${u(0xa0, 0x80)}` }];
    // The server wrote 134 characters: every non-ASCII code unit, " < > & ' + ` and the control
    // characters other than newline and tab as six-character escapes.
    expect(serverJsonLength(value)).toBe(134);
    // [{"name":"back\\slash","gen":"\u001F\b\f\r"}]
    expect(serverJsonLength([{ name: 'back\\slash', gen: '\u001f\b\f\r' }])).toBe(45);
    // [{"name":"x","gen":null,"n":1.5,"b":true,"e":""}]
    expect(serverJsonLength([{ name: 'x', gen: null, n: 1.5, b: true, e: '' }])).toBe(49);
  });

  it('equals JSON.stringify for plain ASCII', () => {
    const value = [{ group: 'Tables', name: 'Loot', gen: '| a | b |\n|---|---|\n{{note\n## Hello\n}}' }, { name: 'Two', gen: '' }];
    expect(serverJsonLength(value)).toBe(JSON.stringify(value).length);
    expect(serverJsonLength(null)).toBe(4);
    expect(serverJsonLength([])).toBe(2);
    expect(jsonStringLength('a\u0000b')).toBe(4);
  });

  it('checks the 2 MB limit', () => {
    const fits = [{ name: 'Big', gen: 'x'.repeat(MAX_SNIPPETS_JSON - 25) }];
    expect(serverJsonLength(fits)).toBe(MAX_SNIPPETS_JSON);
    expect(snippetsFit(fits)).toBe(true);
    expect(snippetsFit([{ name: 'Big', gen: 'x'.repeat(MAX_SNIPPETS_JSON - 24) }])).toBe(false);
    // Non-ASCII counts six times (the server escapes it).
    expect(snippetsFit([{ name: 'Big', gen: String.fromCharCode(0xe9).repeat(MAX_SNIPPETS_JSON / 6) }])).toBe(false);
  });
});
