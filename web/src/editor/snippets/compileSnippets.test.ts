import { describe, expect, it } from 'vitest';
import blankSnippets from '@themes/V3/Blank/snippets.js';
import phbSnippets from '@themes/V3/5ePHB/snippets.js';
import { compileSnippets, groupsForView, loadSnippetGroups, mergeSnippetGroups, mergeSnippetLists, staticSnippetIds } from './compileSnippets';
import { nativeActionOf } from './native';
import { STATIC_SNIPPET_LOADERS, hasStaticSnippets, loadStaticSnippets } from './staticSnippets';
import type { ThemeSnippet, ThemeSnippetGroup } from './themeSnippets';

const snip = (name: string, gen: string | undefined = name.toLowerCase(), extra: Partial<ThemeSnippet> = {}): ThemeSnippet => ({
  name,
  icon: '',
  ...(gen !== undefined ? { gen } : {}),
  ...extra,
});
const group = (groupName: string, snippets: ThemeSnippet[], view: 'text' | 'style' = 'text', icon = ''): ThemeSnippetGroup => ({
  groupName,
  icon,
  view,
  snippets,
});
const names = (list: readonly ThemeSnippet[]) => list.map((s) => s.name);

describe('mergeSnippetLists (upstream mergeCustomizer)', () => {
  it('keeps the parent snippets the child does not override, then the child snippets', () => {
    const parent = [snip('A', 'pa'), snip('B', 'pb'), snip('C', 'pc')];
    const child = [snip('D', 'cd'), snip('B', 'cb')];
    const merged = mergeSnippetLists(parent, child);
    expect(names(merged)).toEqual(['A', 'C', 'D', 'B']);
    expect(merged.find((s) => s.name === 'B')?.gen).toBe('cb');
  });

  it('drops entries with neither generator nor subsnippets', () => {
    const merged = mergeSnippetLists(undefined, [snip('X', ''), { name: 'Y', icon: '' }, { name: 'Z', icon: '', subsnippets: [] }, snip('W')]);
    expect(names(merged)).toEqual(['Z', 'W']);
  });

  it('keeps the last of duplicate names within one list', () => {
    const merged = mergeSnippetLists([], [snip('A', 'first'), snip('A', 'second')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.gen).toBe('second');
  });
});

describe('mergeSnippetGroups', () => {
  it('merges groups by name in place and appends new groups; inputs stay unchanged', () => {
    const base = [group('Text', [snip('A'), snip('B')], 'text', 'base-icon'), group('Style', [snip('S')], 'style')];
    const child = [group('Extra', [snip('E')]), group('Text', [snip('B', 'child-b')], 'text', 'child-icon')];
    const before = JSON.stringify([base, child]);
    const merged = mergeSnippetGroups(base, child);
    expect(merged.map((g) => g.groupName)).toEqual(['Text', 'Style', 'Extra']);
    expect(merged[0]?.icon).toBe('child-icon');
    expect(names(merged[0]!.snippets)).toEqual(['A', 'B']);
    expect(merged[0]!.snippets[1]?.gen).toBe('child-b');
    expect(JSON.stringify([base, child])).toBe(before);
  });
});

describe('static theme snippets', () => {
  it('has a loader per V3 theme with snippets.js', () => {
    expect(Object.keys(STATIC_SNIPPET_LOADERS).sort()).toEqual(['V3_5eDMG', 'V3_5ePHB', 'V3_Blank', 'V3_Journal']);
    expect(hasStaticSnippets('V3_UnearthedArcana')).toBe(false);
    expect(hasStaticSnippets('toString')).toBe(false);
  });

  it('loads a module, and nothing for unknown or legacy ids', async () => {
    expect((await loadStaticSnippets('V3_5ePHB')).map((g) => g.groupName)).toContain('PHB');
    expect(await loadStaticSnippets('Legacy_5ePHB')).toEqual([]);
    expect(await loadStaticSnippets('V3_UnearthedArcana')).toEqual([]);
  });

  it('Blank loads with the native footer and TOC shims (no marked-hbfm)', () => {
    const text = blankSnippets.find((g) => g.groupName === 'Text Editor')!;
    const footer = text.snippets.find((s) => s.name === 'Footer')!;
    expect(nativeActionOf(footer.gen)).toEqual({ kind: 'footer', level: 1 });
    expect(footer.subsnippets?.map((s) => nativeActionOf(s.gen))).toEqual(
      [1, 2, 3, 4, 5, 6].map((level) => ({ kind: 'footer', level })),
    );
    const toc = text.snippets.find((s) => s.name === 'Table of Contents')!;
    expect(nativeActionOf(toc.gen)).toEqual({ kind: 'toc' });
    expect(nativeActionOf(toc.subsnippets?.[0]?.gen)).toEqual({ kind: 'toc' });
    // The shims still return markdown when called directly.
    expect(typeof footer.gen === 'function' ? footer.gen({}) : '').toContain('{{footnote PART 1 | SECTION NAME}}');
    expect(typeof toc.gen === 'function' ? toc.gen({}) : '').toContain('{{toc,wide');
  });
});

describe('compileSnippets', () => {
  const staticGroups = { V3_Blank: blankSnippets, V3_5ePHB: phbSnippets };

  it('merges the chain root first (Blank, then 5ePHB) as upstream', () => {
    const groups = compileSnippets({ refs: ['V3_Blank', 'V3_5ePHB'], staticGroups });
    expect(groups.map((g) => `${g.groupName}:${g.view}`)).toEqual([
      'Text Editor:text',
      'License:text',
      'Style Editor:style',
      'Images:text',
      'Tables:text',
      'Fonts:text',
      'Print:style',
      'PHB:text',
    ]);
    // Blank's tables first, then 5ePHB's.
    expect(names(groups.find((g) => g.groupName === 'Tables')!.snippets)).toEqual(['Table', 'Wide Table', 'Split Table', 'Class Tables', 'Rune Table']);
    // 5ePHB's "Ink Friendly" replaces Blank's, after Blank's page sizes.
    const print = groups.find((g) => g.groupName === 'Print')!.snippets;
    expect(names(print).at(-1)).toBe('Ink Friendly');
    expect(print.at(-1)?.gen).toBe(phbSnippets.find((g) => g.groupName === 'Print')!.snippets[0]!.gen);
    expect(names(groups.find((g) => g.groupName === 'Style Editor')!.snippets)).toEqual(['Add Comment', 'Remove Drop Cap', 'Tweak Drop Cap']);
  });

  it('ignores unknown ids and adds the Brew Snippets group last', () => {
    const groups = compileSnippets({
      refs: ['V3_Blank', 'V3_Nope', { name: 'My Theme', snippets: '\\snippet Hello\nHi there\n' }],
      staticGroups,
      userSnippets: [{ name: 'Mine', gen: '**bold**' }],
      brewTitle: 'The Brew',
    });
    const last = groups.at(-1)!;
    expect(last.groupName).toBe('Brew Snippets');
    expect(last.view).toBe('text');
    expect(last.snippets.map((s) => [s.name, s.subsnippets?.map((x) => [x.name, x.gen])])).toEqual([
      ['My Theme', [['Hello', 'Hi there']]],
      ['The Brew', [['Mine', '**bold**']]],
    ]);
  });

  it('has no Brew Snippets group without user snippets', () => {
    expect(compileSnippets({ refs: ['V3_Blank'], staticGroups }).some((g) => g.groupName === 'Brew Snippets')).toBe(false);
  });

  it('splits by view', () => {
    const groups = compileSnippets({ refs: ['V3_Blank', 'V3_5ePHB'], staticGroups });
    expect(groupsForView(groups, 'style').map((g) => g.groupName)).toEqual(['Style Editor', 'Print']);
    expect(groupsForView(groups, 'text').map((g) => g.groupName)).not.toContain('Print');
  });

  it('staticSnippetIds de-duplicates and skips user themes', () => {
    expect(staticSnippetIds(['V3_Blank', { name: 'x', snippets: [] }, 'V3_Blank', 'V3_5ePHB'])).toEqual(['V3_Blank', 'V3_5ePHB']);
  });

  it('loadSnippetGroups loads the modules of the chain (5eDMG: Blank → 5ePHB → 5eDMG)', async () => {
    const groups = await loadSnippetGroups({ refs: ['V3_Blank', 'V3_5ePHB', 'V3_5eDMG'], brewTitle: '' });
    expect(groups.map((g) => g.groupName)).toContain('PHB');
    expect(groups.map((g) => g.groupName)).toContain('License');
  });
});
