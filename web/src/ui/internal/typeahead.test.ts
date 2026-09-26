import { describe, expect, it } from 'vitest';
import { createTypeahead, findTypeaheadMatch, isTypeaheadKey } from './typeahead';

const labels = ['Paragraph', 'Heading 1', 'Heading 2', 'Bullet list', 'Page break', 'Table'];

describe('typeahead', () => {
  it('a single character finds the next match after the current item, wrapping', () => {
    expect(findTypeaheadMatch(labels, 'h', 0)).toBe(1);
    expect(findTypeaheadMatch(labels, 'h', 1)).toBe(2);
    expect(findTypeaheadMatch(labels, 'h', 2)).toBe(1);
    expect(findTypeaheadMatch(labels, 'p', 0)).toBe(4);
    expect(findTypeaheadMatch(labels, 'p', -1)).toBe(0);
  });

  it('repeating a character cycles; a longer string matches from the current item', () => {
    expect(findTypeaheadMatch(labels, 'hh', 1)).toBe(2);
    expect(findTypeaheadMatch(labels, 'pa', 0)).toBe(0);
    expect(findTypeaheadMatch(labels, 'pag', 0)).toBe(4);
    expect(findTypeaheadMatch(labels, 'heading 2', 1)).toBe(2);
  });

  it('skips disabled items and reports no match', () => {
    expect(findTypeaheadMatch(labels, 't', 0, (i) => i === 5)).toBe(-1);
    expect(findTypeaheadMatch(labels, 'h', 0, (i) => i === 1)).toBe(2);
    expect(findTypeaheadMatch(labels, 'z', 0)).toBe(-1);
    expect(findTypeaheadMatch([], 'a', 0)).toBe(-1);
    expect(findTypeaheadMatch(labels, '', 0)).toBe(-1);
  });

  it('buffers characters within the timeout', () => {
    const t = createTypeahead(500);
    expect(t.push('P', 1000)).toBe('p');
    expect(t.push('a', 1200)).toBe('pa');
    expect(t.push('g', 1800)).toBe('g');
    t.reset();
    expect(t.push('x', 1900)).toBe('x');
  });

  it('isTypeaheadKey', () => {
    const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      ...mods,
    });
    expect(isTypeaheadKey(key('a'))).toBe(true);
    expect(isTypeaheadKey(key('A'))).toBe(true);
    expect(isTypeaheadKey(key(' '))).toBe(false);
    expect(isTypeaheadKey(key('ArrowDown'))).toBe(false);
    expect(isTypeaheadKey(key('a', { ctrlKey: true }))).toBe(false);
  });
});
