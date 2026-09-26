import { describe, expect, it } from 'vitest';
import { countErrors, displayOrder, type EditableSnippet, groupLabel, groupNames, groupSnippets, snippetIssues, uniqueName } from './snippetsModel';

const s = (key: string, name: string, gen = 'x', group = ''): EditableSnippet => ({ key, name, gen, group });

describe('snippetIssues', () => {
  it('finds duplicate names per Insert-menu submenu, ignoring case, accents forms and spaces', () => {
    const list = [s('a', 'Goblin'), s('b', ' goblin '), s('c', 'Goblin', 'x', 'Monsters'), s('d', 'Orc', 'x', 'My Brew')];
    const issues = snippetIssues([...list, s('e', 'orc')], 'My Brew');
    expect(issues.get('a')?.map((i) => i.code)).toEqual(['duplicateName']);
    expect(issues.get('b')?.map((i) => i.code)).toEqual(['duplicateName']);
    // Another submenu: no clash.
    expect(issues.has('c')).toBe(false);
    // A group equal to the brew title is the title's submenu.
    expect(issues.get('d')?.[0]?.message).toContain('“My Brew”');
    expect(issues.get('e')?.[0]?.code).toBe('duplicateName');
    expect(countErrors(issues)).toBe(4);
  });

  it('requires a name, refuses the group separator, and warns about empty bodies and \\snippet lines', () => {
    const issues = snippetIssues([s('a', '  '), s('b', 'A › B'), s('c', 'C', 'x', 'G›H'), s('d', 'D', '  \n'), s('e', 'E', 'one\n\\snippet two')], 'T');
    expect(issues.get('a')!.map((i) => [i.code, i.field, i.severity])).toEqual([['nameRequired', 'name', 'error']]);
    expect(issues.get('b')!.map((i) => i.code)).toEqual(['separator']);
    expect(issues.get('c')!.map((i) => [i.code, i.field])).toEqual([['separator', 'group']]);
    expect(issues.get('d')!.map((i) => [i.code, i.severity])).toEqual([['emptyBody', 'warning']]);
    expect(issues.get('e')!.map((i) => [i.code, i.severity])).toEqual([['headerLine', 'warning']]);
    // Warnings don't count as errors.
    expect(countErrors(issues)).toBe(3);
  });
});

describe('grouping', () => {
  it("groups like the Insert menu: first appearance, the title's submenu for no group", () => {
    const list = [s('a', 'A', 'x', 'Tables'), s('b', 'B'), s('c', 'C', 'x', 'Tables'), s('d', 'D', 'x', 'Brew'), s('e', 'E', 'x', ' Maps ')];
    const groups = groupSnippets(list, 'Brew');
    expect(groups.map((g) => [g.label, g.group, g.snippets.map((x) => x.key)])).toEqual([
      ['Tables', 'Tables', ['a', 'c']],
      ['Brew', '', ['b', 'd']],
      ['Maps', 'Maps', ['e']],
    ]);
    expect(displayOrder(list, 'Brew').map((x) => x.key)).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(groupNames(list)).toEqual(['Tables', 'Brew', 'Maps']);
    expect(groupLabel('  ', 'Title')).toBe('Title');
  });

  it('numbers new names within their submenu', () => {
    const list = [s('a', 'New snippet'), s('b', 'new snippet 2'), s('c', 'New snippet', 'x', 'G')];
    expect(uniqueName(list, 'New snippet', '', 'T')).toBe('New snippet 3');
    expect(uniqueName(list, 'New snippet', 'Other', 'T')).toBe('New snippet');
    expect(uniqueName(list, 'New snippet', 'G', 'T')).toBe('New snippet 2');
  });
});
