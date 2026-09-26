// Class suggestions (P3.5): the class picker's theme classes (cached), the document's classes,
// and the ranking the inspector's class fields use.
import { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { docOf, node, p, page, schema, text } from '@/editor/schema/testing';
import type { ThemeClass } from '../classPicker/themeClasses';
import { documentClassNames, filterClassSuggestions, rankClassSuggestions, themeClasses } from './classNames';

const styles: HTMLStyleElement[] = [];
afterEach(() => {
  for (const style of styles.splice(0)) style.remove();
});
function addStyle(css: string): void {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  styles.push(style);
}

describe('themeClasses', () => {
  it('reads canvas-scoped rules (not app chrome) and caches while the sheets are the same', () => {
    addStyle(`
      .hb-canvas .page .monster.frame h2 { color: red }
      .hb-canvas .page .monster { margin: 0 }
      @media print { .hb-canvas .page .wide { column-span: all } }
      .appChrome_x1 .button { color: blue }
    `);
    const first = themeClasses();
    expect(first.map((c) => c.name)).toEqual(['monster', 'frame', 'wide']);
    expect(themeClasses()).toBe(first);
    addStyle('.hb-canvas .note { color: red }');
    expect(themeClasses().map((c) => c.name)).toContain('note');
  });
});

describe('documentClassNames', () => {
  it('collects node, span and page object classes, not reserved ones', () => {
    const json = docOf(
      page([p('x', { classes: ['a', 'block'] }), node('paragraph', undefined, [text('s', [{ type: 'span', attrs: { classes: ['c'] } }])])], {
        objects: [{ id: 'o', kind: 'text', text: 't', classes: ['artist'], style: '' }],
      }),
    );
    expect(documentClassNames(PMNode.fromJSON(schema, json))).toEqual(['a', 'artist', 'c']);
  });
});

describe('rankClassSuggestions', () => {
  const theme: ThemeClass[] = [
    { name: 'wide', rules: 9, block: true, inline: false },
    { name: 'widePage', rules: 1, block: true, inline: false },
    { name: 'smallcaps', rules: 3, block: false, inline: true },
    { name: 'frame', rules: 5, block: true, inline: false },
  ];

  it('ranks by match, then the mode’s element, then usage; the document’s own classes follow', () => {
    expect(rankClassSuggestions(theme, [], 'wi', 'themeBlock', [])).toEqual(['wide', 'widePage']);
    expect(rankClassSuggestions(theme, [], '.WI', 'themeBlock', ['wide'])).toEqual(['widePage']);
    expect(rankClassSuggestions(theme, [], '', 'span', []).slice(0, 1)).toEqual(['smallcaps']);
    expect(rankClassSuggestions(theme, ['wideish', 'wide'], 'wide', 'themeBlock', [])).toEqual(['wide', 'widePage', 'wideish']);
    expect(rankClassSuggestions(theme, [], '', 'themeBlock', [], 2)).toHaveLength(2);
  });
});

describe('filterClassSuggestions', () => {
  const names = ['frame', 'monster', 'wide', 'widePage', 'nowide', 'note'];
  it('prefix matches first, then substring matches; applied ones and past the limit left out', () => {
    expect(filterClassSuggestions(names, 'wi', [])).toEqual(['wide', 'widePage', 'nowide']);
    expect(filterClassSuggestions(names, '.WI', ['wide'])).toEqual(['widePage', 'nowide']);
    expect(filterClassSuggestions(names, '', ['frame'], 2)).toEqual(['monster', 'wide']);
    expect(filterClassSuggestions(names, 'zzz', [])).toEqual([]);
  });
});
