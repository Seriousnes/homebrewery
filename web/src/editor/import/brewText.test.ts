import { describe, expect, it } from 'vitest';
import { brewSnippetsToJSON, splitTextStyleAndMetadata, yamlSnippetsToText } from './brewText';

const brew = [
  '```metadata',
  'title: My Brew',
  'description: A test',
  'renderer: V3',
  'theme: 5eDMG',
  'lang: fr',
  'tags: [ignored]',
  'snippets:',
  '  - name: My Brew',
  '    subsnippets:',
  '      - name: Greeting',
  '        gen: "Hello *world*"',
  '      - name: Empty',
  'trimSize:',
  '  width: 8.5in',
  '```',
  '',
  '```css',
  '.page { color: red; }',
  '```',
  '',
  '# Title',
  '',
  'Text',
].join('\r\n');

describe('splitTextStyleAndMetadata', () => {
  it('splits metadata, CSS and markdown like helpers.js', () => {
    const out = splitTextStyleAndMetadata({ text: brew });
    expect(out.text).toBe('# Title\n\nText');
    expect(out.style).toBe('.page { color: red; }\n');
    expect(out).toMatchObject({ title: 'My Brew', description: 'A test', renderer: 'V3', theme: '5eDMG', lang: 'fr' });
    expect(out.snippets).toBe('\\snippet Greeting\nHello *world*\n\\snippet Empty\n\n');
    expect(out.trimSize).toEqual({ width: '8.5in' });
    expect(out.bleedSize).toEqual({});
    expect(out.metadataError).toBeUndefined();
  });

  it('handles a CSS block without metadata', () => {
    const out = splitTextStyleAndMetadata({ text: '```css\na{}\n```\n\nBody' });
    expect(out.style).toBe('a{}\n');
    expect(out.text).toBe('Body');
    expect(out.title).toBeUndefined();
  });

  it('leaves text without blocks alone', () => {
    expect(splitTextStyleAndMetadata({ text: '# Hi\n```css\nx\n```\n\n' })).toEqual({ text: '# Hi\n```css\nx\n```\n\n' });
  });

  it('leaves an unterminated block in the text (upstream sliced garbage)', () => {
    const out = splitTextStyleAndMetadata({ text: '```metadata\ntitle: x\n# no fence' });
    expect(out.text).toBe('```metadata\ntitle: x\n# no fence');
  });

  it('reports YAML errors instead of throwing, and ignores non-mapping metadata', () => {
    const bad = splitTextStyleAndMetadata({ text: '```metadata\ntitle: [unclosed\n```\n\nBody' });
    expect(bad.text).toBe('Body');
    expect(bad.metadataError).toBeTruthy();
    const list = splitTextStyleAndMetadata({ text: '```metadata\n- a\n- b\n```\n\nBody' });
    expect(list.metadataError).toMatch(/mapping/);
    expect(list.title).toBeUndefined();
  });

  it('does not execute YAML tags', () => {
    const out = splitTextStyleAndMetadata({ text: '```metadata\ntitle: !!js/function "function(){}"\n```\n\nBody' });
    expect(out.text).toBe('Body');
    expect(typeof out.title === 'string' || out.title === undefined).toBe(true);
  });

  it('normalizes old string tags', () => {
    expect(splitTextStyleAndMetadata({ text: '', tags: '' }).tags).toEqual([]);
    expect(splitTextStyleAndMetadata({ text: '', tags: 'rpg' }).tags).toEqual(['rpg']);
  });
});

describe('user snippets', () => {
  it('yamlSnippetsToText passes strings through', () => {
    expect(yamlSnippetsToText('\\snippet a\nx\n')).toBe('\\snippet a\nx\n');
    expect(yamlSnippetsToText(null)).toBe('');
  });

  it('brewSnippetsToJSON groups \\snippet sections', () => {
    const json = brewSnippetsToJSON('My Brew', '\\snippet One\nfirst\n\\snippet Two\nsecond\n', [
      'V3_5ePHB',
      { name: 'Theme', snippets: '\\snippet T\ntheme text\n' },
    ]);
    expect(json).toEqual({
      snippets: [
        { name: 'Theme', icon: '', gen: '', subsnippets: [{ name: 'T', icon: '', gen: 'theme text' }] },
        { name: 'My Brew', subsnippets: [{ name: 'One', gen: 'first' }, { name: 'Two', gen: 'second' }] },
      ],
      groupName: 'Brew Snippets',
      icon: 'fas fa-th-list',
      view: 'text',
    });
    expect(brewSnippetsToJSON('x', '', null, false)).toEqual({ snippets: [] });
  });
});
