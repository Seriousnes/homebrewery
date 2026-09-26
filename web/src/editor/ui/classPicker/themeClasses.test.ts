// themeClasses.ts: the class picker's suggestions from the canvas-scoped stylesheets.
import { afterEach, describe, expect, it } from 'vitest';
import { collectThemeClasses, isSuggestableClass, selectorClasses, suggestClasses, type ThemeClass } from './themeClasses';

type Rule = { selectorText?: string; cssRules?: Rule[] };
const sheet = (...cssRules: Rule[]) => ({ cssRules });
const rule = (selectorText: string, ...cssRules: Rule[]): Rule => (cssRules.length ? { selectorText, cssRules } : { selectorText });
const group = (...cssRules: Rule[]): Rule => ({ cssRules });
const names = (list: readonly ThemeClass[]) => list.map((c) => c.name);

describe('selectorClasses', () => {
  it('finds the classes of every compound, with block, inline and icon context', () => {
    const found = selectorClasses('.hb-canvas .page .monster.frame h2, .hb-canvas div.note > p, .hb-canvas span.inline-block.big, .hb-canvas .df.d20::before');
    expect(found.classes).toEqual(['hb-canvas', 'page', 'monster', 'frame', 'hb-canvas', 'note', 'hb-canvas', 'inline-block', 'big', 'hb-canvas', 'df', 'd20']);
    expect([...found.block]).toEqual(['note']);
    expect([...found.inline]).toEqual(['inline-block', 'big']);
    expect([...found.icon]).toEqual(['df', 'd20']);
  });

  it('ignores attribute selectors and strings, reads escapes and :is() lists', () => {
    const found = selectorClasses('.hb-canvas [class~=".nope"] .a\\:b :is(.x, .y):not(.z) [data-x=".q"]');
    expect(found.classes).toEqual(['hb-canvas', 'a:b', 'x', 'y', 'z']);
  });
});

describe('isSuggestableClass', () => {
  it.each([
    ['note', true],
    ['monster', true],
    ['wide', true],
    ['page', false],
    ['block', false],
    ['inline-block', false],
    ['columnWrapper', false],
    ['hb-cols-2', false],
    ['hb-anything', false],
    ['hb-canvas', false],
    ['ProseMirror-selectednode', false],
    ['df', false],
    ['fa-dragon', false],
    ['fa', false],
    ['frontCover', false],
    ['pageNumber', false],
    ['footnote', false],
    ['toc', false],
    ['columnSplit', false],
  ])('%s → %s', (name, expected) => {
    expect(isSuggestableClass(name)).toBe(expected);
  });
});

describe('collectThemeClasses', () => {
  it('reads canvas-scoped rules only, nested and grouped ones too, most used first', () => {
    const list = collectThemeClasses({
      sheets: [
        sheet(
          rule('.hb-canvas .page .monster h2'),
          rule('.hb-canvas .page .monster.frame'),
          rule('.hb-canvas div.note'),
          rule('._toolbar_abc .chrome'), // app chrome (CSS module): not the canvas
          group(rule('.hb-canvas .page .monster hr'), rule('.other .notme')), // @media
          rule('.hb-canvas .descriptive', rule('&.wide'), rule('.inner')), // CSS nesting
        ),
        sheet(rule('.hb-canvas span.inline-block.big'), rule('.hb-canvas .df.d20::before'), rule('.hb-canvas .fa-dragon::before')),
      ],
    });
    expect(names(list)).toEqual(['monster', 'big', 'descriptive', 'frame', 'inner', 'note', 'wide']);
    expect(list.find((c) => c.name === 'monster')).toMatchObject({ rules: 3, block: false, inline: false });
    expect(list.find((c) => c.name === 'note')).toMatchObject({ rules: 1, block: true });
    expect(list.find((c) => c.name === 'big')).toMatchObject({ inline: true });
  });

  it('skips sheets whose rules cannot be read (cross-origin)', () => {
    const crossOrigin = {
      get cssRules(): Rule[] {
        throw new DOMException('cross-origin', 'SecurityError');
      },
    };
    expect(names(collectThemeClasses({ sheets: [crossOrigin, sheet(rule('.hb-canvas .note'))] }))).toEqual(['note']);
  });

  describe('from the document', () => {
    let style: HTMLStyleElement | undefined;
    afterEach(() => style?.remove());

    it('reads style elements (theme links and user CSS work the same way)', () => {
      style = document.createElement('style');
      style.textContent = '.hb-canvas .page .note { color: red } .hb-canvas .page .wide { column-span: all } .app .x { color: blue }';
      document.head.append(style);
      expect(names(collectThemeClasses())).toEqual(expect.arrayContaining(['note', 'wide']));
      expect(names(collectThemeClasses())).not.toContain('x');
    });
  });
});

describe('suggestClasses', () => {
  const all: ThemeClass[] = [
    { name: 'monster', rules: 30, block: false, inline: false },
    { name: 'note', rules: 10, block: true, inline: false },
    { name: 'descriptive', rules: 8, block: false, inline: false },
    { name: 'noteSmall', rules: 1, block: false, inline: true },
    { name: 'wide', rules: 12, block: false, inline: false },
    { name: 'my-note-box', rules: 2, block: false, inline: false },
    { name: 'denote', rules: 3, block: false, inline: false },
  ];

  it('without a query: the mode’s element first, then the most used', () => {
    expect(names(suggestClasses(all, '', 'themeBlock')).slice(0, 3)).toEqual(['note', 'monster', 'wide']);
    expect(names(suggestClasses(all, '', 'span')).slice(0, 2)).toEqual(['noteSmall', 'monster']);
  });

  it('ranks exact, prefix, word start, then anywhere; leaves out chosen classes', () => {
    expect(names(suggestClasses(all, 'note', 'themeBlock'))).toEqual(['note', 'noteSmall', 'my-note-box', 'denote']);
    expect(names(suggestClasses(all, 'small', 'span'))).toEqual(['noteSmall']);
    expect(names(suggestClasses(all, 'NOTE', 'span', ['note']))).toEqual(['noteSmall', 'my-note-box', 'denote']);
    expect(suggestClasses(all, 'zzz', 'span')).toEqual([]);
  });
});
