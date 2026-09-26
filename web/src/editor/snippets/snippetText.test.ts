import { describe, expect, it } from 'vitest';
import { brewSnippetsToJSON } from '../import/brewText';
import { hasSnippetHeaderLine, isSnippetHeader, parseSnippetText, snippetLabel, snippetsToText, splitGroupAndName } from './snippetText';
import { parseUserSnippets } from './userSnippets';

describe('parseSnippetText', () => {
  it('reads headers and bodies like upstream', () => {
    const text = '\\snippet Hello\nHi *there*\n\\snippet  Two \nline 1\n\nline 2\n';
    expect(parseSnippetText(text)).toEqual({
      snippets: [
        { group: '', name: 'Hello', gen: 'Hi *there*' },
        { group: '', name: 'Two', gen: 'line 1\n\nline 2' },
      ],
      ignored: '',
      skipped: 0,
    });
    // Same names and bodies as upstream's brewSnippetsToJSON for ordinary text.
    const upstream = brewSnippetsToJSON('Brew', text, null, false).snippets[0]!.subsnippets.map((s) => ({ name: s.name, gen: s.gen }));
    expect(parseSnippetText(text).snippets.map(({ name, gen }) => ({ name, gen }))).toEqual(upstream);
  });

  it('reads a group before "›"', () => {
    expect(parseSnippetText('\\snippet Monsters › Goblin\n{{monster\n}}\n\\snippet  Tables›Loot \n|a|\n').snippets).toEqual([
      { group: 'Monsters', name: 'Goblin', gen: '{{monster\n}}' },
      { group: 'Tables', name: 'Loot', gen: '|a|' },
    ]);
  });

  it('reports text before the first header and skips headers without a name', () => {
    const parsed = parseSnippetText('Intro text\n\n\\snippet    \nlost body\n\\snippet Kept\nbody');
    expect(parsed.snippets).toEqual([{ group: '', name: 'Kept', gen: 'body' }]);
    expect(parsed.ignored).toBe('Intro text');
    expect(parsed.skipped).toBe(1);
  });

  it('needs a space after \\snippet, accepts CRLF and a final header without a line break', () => {
    expect(parseSnippetText('\\snippetX\nno').snippets).toEqual([]);
    expect(parseSnippetText('\\snippet A\r\none\r\ntwo\r\n\\snippet B').snippets).toEqual([
      { group: '', name: 'A', gen: 'one\ntwo' },
      { group: '', name: 'B', gen: '' },
    ]);
    expect(parseSnippetText('').snippets).toEqual([]);
  });

  it('round-trips snippetsToText exactly, including empty bodies and trailing blank lines', () => {
    const snippets = [
      { group: '', name: 'Empty', gen: '' },
      { group: 'G', name: 'Trailing', gen: 'x\n\n' },
      { group: '', name: 'Unicode ✓', gen: '  indented\n{{note\n}}' },
      { group: 'Last', name: 'End', gen: 'last\n' },
    ];
    const text = snippetsToText(snippets);
    expect(text.startsWith('\\snippet Empty\n\n\\snippet G › Trailing\nx\n\n\n')).toBe(true);
    expect(parseSnippetText(text).snippets).toEqual(snippets);
  });

  it("is what upstream's parser reads as names with the group in front", () => {
    const text = snippetsToText([{ group: 'Monsters', name: 'Goblin', gen: 'g' }]);
    expect(parseUserSnippets(text).map((s) => s.name)).toEqual(['Monsters › Goblin']);
  });
});

describe('text form helpers', () => {
  it('splits and joins labels', () => {
    expect(splitGroupAndName(' Name ')).toEqual({ group: '', name: 'Name' });
    expect(splitGroupAndName('A › B › C')).toEqual({ group: 'A', name: 'B › C' });
    expect(splitGroupAndName('› B')).toEqual({ group: '', name: 'B' });
    expect(snippetLabel('', 'N')).toBe('N');
    expect(snippetLabel(' G ', 'N')).toBe('G › N');
  });

  it('finds lines that would start a snippet', () => {
    expect(isSnippetHeader('\\snippet x')).toBe(true);
    expect(isSnippetHeader(' \\snippet x')).toBe(false);
    expect(hasSnippetHeaderLine('a\n\\snippet b')).toBe(true);
    expect(hasSnippetHeaderLine('a \\snippet b')).toBe(false);
  });
});
