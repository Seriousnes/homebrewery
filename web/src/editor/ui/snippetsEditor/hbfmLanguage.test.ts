import { highlightTree } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';
import { hbfmHighlight, hbfmLanguage } from './hbfmLanguage';

/** The text of every highlighted range, with the highlight style's class (one per tag). */
function highlighted(text: string): string[] {
  const tree = hbfmLanguage.parser.parse(text);
  const out: string[] = [];
  highlightTree(tree, hbfmHighlight, (from, to) => out.push(text.slice(from, to)));
  return out;
}

describe('hbfmLanguage', () => {
  it('highlights headings, block syntax, breaks, tags, comments, links and emphasis', () => {
    const text = [
      '## Goblin',
      '{{note,wide',
      'Plain **bold** and *italic* text, see https://example.com/x.',
      '}}',
      '\\page',
      '<div class="x">',
      '<!-- a',
      'comment -->',
      ':::',
    ].join('\n');
    expect(highlighted(text)).toEqual([
      '## Goblin',
      '{{note,wide',
      '**bold**',
      '*italic*',
      'https://example.com/x.',
      '}}',
      '\\page',
      '<div',
      '>',
      '<!-- a',
      'comment -->',
      ':::',
    ]);
  });

  it('leaves plain text alone, including a ">" outside a tag', () => {
    expect(highlighted('Just some words, 2 * 3 = 6 > 5.')).toEqual([]);
    // A tag across lines ends at its ">"; a self-closing one at "/>".
    expect(highlighted('<img src="a.png"\n  alt="x" />text')).toEqual(['<img', '/>']);
  });
});
