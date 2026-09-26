import { describe, expect, it } from 'vitest';
import { describeNativeAction, nativeActionOf, nativeGenerator } from './native';
import { filterSections, findSnippet, pathLabel, snippetSections } from './snippetTree';
import { generateStyleSnippet, insertStyleSnippet } from './styleSnippets';
import type { ThemeSnippetGroup } from './themeSnippets';
import { parseUserSnippets, userSnippetGroup } from './userSnippets';

describe('parseUserSnippets', () => {
  it('reads the \\snippet text form', () => {
    expect(parseUserSnippets('\\snippet Hello\nHi *there*\n\\snippet  Two \nline 1\nline 2\n', 'Brew')).toEqual([
      { group: 'Brew', name: 'Hello', gen: 'Hi *there*' },
      { group: 'Brew', name: 'Two', gen: 'line 1\nline 2' },
    ]);
    expect(parseUserSnippets('   ')).toEqual([]);
  });

  it("reads upstream's stored form and the plan's flat form", () => {
    expect(parseUserSnippets([{ name: 'Group A', subsnippets: [{ name: 'One', gen: '1' }, { name: '', gen: 'x' }, { name: 'Bad', gen: 5 }] }])).toEqual([
      { group: 'Group A', name: 'One', gen: '1' },
    ]);
    expect(parseUserSnippets([{ group: 'G', name: 'N', gen: 'text' }, { name: 'No group', gen: 'y' }, { name: 'no gen' }, 'junk', null], 'Default')).toEqual([
      { group: 'G', name: 'N', gen: 'text' },
      { group: 'Default', name: 'No group', gen: 'y' },
    ]);
    expect(parseUserSnippets(42)).toEqual([]);
  });
});

describe('userSnippetGroup', () => {
  it('groups user-theme snippets per theme, then the brew snippets under its title', () => {
    const group = userSnippetGroup(' ', [{ group: 'Tables', name: 'T1', gen: '|a|' }, { name: 'Loose', gen: 'l' }], [
      'V3_Blank',
      { name: 'Dark Theme', snippets: [{ name: 'Section', subsnippets: [{ name: 'Banner', gen: '{{banner x}}' }] }] },
      { name: 'Empty Theme', snippets: [] },
    ]);
    expect(group?.groupName).toBe('Brew Snippets');
    expect(group?.snippets.map((s) => [s.name, s.subsnippets?.map((x) => x.name)])).toEqual([
      ['Dark Theme', ['Banner']],
      ['Tables', ['T1']],
      ['New Document', ['Loose']],
    ]);
    expect(userSnippetGroup('T', null)).toBeNull();
  });
});

const groups: ThemeSnippetGroup[] = [
  {
    groupName: 'Text',
    icon: '',
    view: 'text',
    snippets: [
      { name: 'Plain', icon: '', gen: 'x' },
      { name: 'Parent', icon: '', gen: 'ignored', subsnippets: [{ name: 'Child', icon: '', gen: () => 'c', experimental: true }] },
      { name: 'Numbers', icon: '', gen: '{{pageNumber,auto}}\n' },
      { name: 'Off', icon: '', gen: 'x', disabled: true },
      { name: 'No gen', icon: '' },
    ],
  },
  { groupName: 'Style', icon: '', view: 'style', snippets: [{ name: 'Café Crème', icon: '', gen: '.a{}' }] },
];

describe('snippetSections', () => {
  it('flattens groups into sections; submenus become sections, their parent generator is not offered', () => {
    const sections = snippetSections(groups);
    expect(sections.map((s) => [s.label, s.entries.map((e) => e.name)])).toEqual([
      ['Text', ['Plain', 'Numbers', 'Off']],
      ['Text › Parent', ['Child']],
      ['Style', ['Café Crème']],
    ]);
    const numbers = findSnippet(sections, ['Text', 'Numbers'])!;
    expect(numbers.native).toEqual({ kind: 'pageNumber' });
    expect(numbers.hint).toBe('Turns on page numbers for this section');
    expect(findSnippet(sections, ['Text', 'Parent', 'Child'])?.experimental).toBe(true);
    expect(findSnippet(sections, ['Text', 'Off'])?.disabled).toBe(true);
    expect(findSnippet(sections, ['Nope'])).toBeNull();
    expect(pathLabel(['a', 'b'])).toBe('a › b');
  });

  it('filters by every word, accent- and case-insensitively, in names and paths', () => {
    const sections = snippetSections(groups);
    expect(filterSections(sections, 'cafe creme').map((s) => s.label)).toEqual(['Style']);
    expect(filterSections(sections, 'parent child').flatMap((s) => s.entries.map((e) => e.name))).toEqual(['Child']);
    expect(filterSections(sections, 'text')).toHaveLength(2);
    expect(filterSections(sections, '  ')).toHaveLength(3);
    expect(filterSections(sections, 'zzz')).toEqual([]);
  });
});

describe('native actions', () => {
  it('are recognised from shim generators and whole-snippet markdown', () => {
    expect(nativeActionOf(nativeGenerator({ kind: 'toc' }, 'x'))).toEqual({ kind: 'toc' });
    expect(nativeActionOf('\n\\page\n')).toEqual({ kind: 'pageBreak' });
    expect(nativeActionOf('{{skipCounting}}\n')).toEqual({ kind: 'marker', marker: 'skipCounting' });
    expect(nativeActionOf('{{resetCounting}}')).toEqual({ kind: 'marker', marker: 'resetCounting' });
    expect(nativeActionOf('{{pageNumber 1}}\n')).toBeNull();
    expect(nativeActionOf(() => 'x')).toBeNull();
    expect(nativeActionOf(undefined)).toBeNull();
    expect(describeNativeAction({ kind: 'footer', level: 2 })).toContain('level 2');
  });
});

describe('style snippets', () => {
  it('generate CSS and insert it at the end or at a range', () => {
    expect(generateStyleSnippet({ name: 'x', gen: (ctx) => `/* ${String((ctx as { view?: string }).view)} */` })).toBe('/* style */');
    expect(insertStyleSnippet('', '.a { color: red }')).toEqual({ css: '.a { color: red }\n', cursor: 17 });
    expect(insertStyleSnippet('.x {}\n\n\n', '\n.a {}')).toEqual({ css: '.x {}\n\n.a {}\n', cursor: 12 });
    expect(insertStyleSnippet('.x {} .y {}', '.a {}', { from: 6, to: 11 })).toEqual({ css: '.x {} .a {}', cursor: 11 });
  });
});
