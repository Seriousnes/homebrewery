// Icon catalog, search and `:` autocomplete (P5.5).
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEditorExtensions } from '../editorExtensions';
import { docWith, p } from '../schema/testing';
import { ICON_SETS, iconByName, iconCatalog, iconClasses, queryWords, searchIcons } from './catalog';
import { insertIcon, IconSuggestion } from './extension';
import { acceptSuggestion, dismissSuggestion, iconSuggestionKey, moveSuggestion, SUGGESTION_LIMIT } from './suggestion';

describe('icon catalog', () => {
  it('has all four icon fonts, each searchable', () => {
    const catalog = iconCatalog();
    for (const set of ICON_SETS) expect(catalog.filter((e) => e.set === set.id).length, set.label).toBeGreaterThan(100);
    expect(new Set(catalog.map((e) => e.font))).toEqual(new Set(['df', 'ei', 'gi', 'fas', 'far', 'fab']));
    // One query per font finds its icons.
    expect(searchIcons('d20', { set: 'dice' }).total).toBeGreaterThan(0);
    expect(searchIcons('spell', { set: 'elderberryInn' }).total).toBeGreaterThan(0);
    expect(searchIcons('dragon', { set: 'gameIcons' }).total).toBeGreaterThan(0);
    expect(searchIcons('dragon', { set: 'fontAwesome' }).total).toBeGreaterThan(0);
  });

  it('maps names to the icon node attributes upstream renders', () => {
    const d12 = iconByName('df_d12_2')!;
    expect(d12).toMatchObject({ font: 'df', glyph: 'd12-2', set: 'dice', label: 'd12 2' });
    expect(iconClasses(d12)).toBe('df d12-2');
    expect(iconByName('fas_dragon')).toMatchObject({ font: 'fas', glyph: 'fa-dragon', set: 'fontAwesome' });
    expect(iconByName('nope')).toBeUndefined();
  });

  it('ranks the exact name, then names starting with the query', () => {
    expect(queryWords(':df_d12_2:')).toEqual(['d12', '2']);
    expect(queryWords('D12-2')).toEqual(['d12', '2']);
    const results = searchIcons('df_d12_2').results.map((e) => e.name);
    expect(results[0]).toBe('df_d12_2');
    const d12 = searchIcons('d12 1', { set: 'dice' }).results.map((e) => e.name);
    expect(d12.slice(0, 3)).toContain('df_d12_1');
    expect(d12.every((n) => n.includes('d12'))).toBe(true);
    // Substring fallback
    expect(searchIcons('ragon').results.some((e) => e.name.includes('dragon'))).toBe(true);
    expect(searchIcons('zzzzqqq').total).toBe(0);
  });

  it('limits results but reports the total', () => {
    const r = searchIcons('', { limit: 10 });
    expect(r.results).toHaveLength(10);
    expect(r.total).toBe(iconCatalog().length);
  });
});

describe('icon insertion and : autocomplete', () => {
  let editor: Editor | null = null;
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function make(text = 'Roll ') {
    const element = document.createElement('div');
    document.body.append(element);
    editor = new Editor({ element, extensions: buildEditorExtensions({ extensions: [IconSuggestion] }), content: docWith(p(text)) });
    editor.commands.setTextSelection(2 + text.length);
    return editor;
  }

  const type = (e: Editor, text: string) => {
    for (const ch of text) {
      const { from, to } = e.state.selection;
      const handled = e.view.someProp('handleTextInput', (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)));
      if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to));
    }
  };

  it('opens a list after `:` and two characters, and inserts the chosen icon for `:query`', () => {
    const e = make();
    type(e, ':d');
    expect(iconSuggestionKey.getState(e.state)!.active).toBe(false);
    type(e, '12');
    const s = iconSuggestionKey.getState(e.state)!;
    expect(s.active).toBe(true);
    expect(s.query).toBe('d12');
    expect(s.results.length).toBeGreaterThan(0);
    expect(s.results.length).toBeLessThanOrEqual(SUGGESTION_LIMIT);
    expect(e.view.dom.getAttribute('aria-autocomplete')).toBe('list');
    expect(e.view.dom.getAttribute('aria-activedescendant')).toMatch(/-0$/);
    moveSuggestion(e.view, 1);
    expect(e.view.dom.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    const chosen = iconSuggestionKey.getState(e.state)!.results[1]!;
    expect(acceptSuggestion(e.view)).toBe(true);
    const para = e.state.doc.firstChild!.firstChild!;
    expect(para.textContent).toBe('Roll ');
    expect(para.lastChild!.type.name).toBe('icon');
    expect(para.lastChild!.attrs).toMatchObject({ font: chosen.font, glyph: chosen.glyph });
    expect(iconSuggestionKey.getState(e.state)!.active).toBe(false);
    expect(e.view.dom.hasAttribute('aria-activedescendant')).toBe(false);
    // One undo step removes the icon and brings the query text back.
    e.commands.undo();
    expect(e.state.doc.firstChild!.firstChild!.textContent).toBe('Roll :d12');
  });

  it('Escape closes the list for that colon', () => {
    const e = make();
    type(e, ':dra');
    expect(iconSuggestionKey.getState(e.state)!.active).toBe(true);
    dismissSuggestion(e.view);
    expect(iconSuggestionKey.getState(e.state)!.active).toBe(false);
    type(e, 'g');
    expect(iconSuggestionKey.getState(e.state)!.active).toBe(false);
    type(e, ' :dr');
    expect(iconSuggestionKey.getState(e.state)!.active).toBe(true);
  });

  it('does not open inside a word or without matches', () => {
    const e = make('time');
    type(e, ':d12');
    expect(iconSuggestionKey.getState(e.state)!.active).toBe(false);
    const e2 = make('Roll ');
    type(e2, ':qqzzxx');
    expect(iconSuggestionKey.getState(e2.state)!.active).toBe(false);
  });

  it('typing a whole :name: inserts the icon at once', () => {
    const e = make();
    type(e, ':df_d12_2:');
    const para = e.state.doc.firstChild!.firstChild!;
    expect(para.lastChild!.type.name).toBe('icon');
    expect(para.lastChild!.attrs).toMatchObject({ font: 'df', glyph: 'd12-2' });
    expect(para.textContent).toBe('Roll ');
    // An unknown name stays text.
    type(e, ' :not_an_icon:');
    expect(e.state.doc.firstChild!.firstChild!.textContent).toBe('Roll  :not_an_icon:');
  });

  it('insertIcon replaces the selection, in text only', () => {
    const e = make('Hello');
    e.commands.setTextSelection({ from: 2, to: 7 });
    expect(insertIcon({ font: 'gi', glyph: 'dragon-head' })(e.state, e.view.dispatch)).toBe(true);
    const para = e.state.doc.firstChild!.firstChild!;
    expect(para.childCount).toBe(1);
    expect(para.firstChild!.attrs).toMatchObject({ font: 'gi', glyph: 'dragon-head' });
    expect(e.view.dom.querySelector('i.gi.dragon-head')).not.toBeNull();
  });
});
