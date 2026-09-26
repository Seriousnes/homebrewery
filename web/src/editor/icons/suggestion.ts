// `:` autocomplete for icons (P5.5). Typing `:` and at least two name characters (`:d12`,
// `:dragon`) at the start of a word opens a list of matching icons from the four icon fonts;
// ArrowUp/ArrowDown choose, Enter or Tab insert the icon node in place of `:query`, Escape closes
// the list for that `:`. Typing a whole known name with its closing colon (`:df_d12_2:`, the
// upstream markdown) inserts the icon at once.
//
// The state lives in a plugin (iconSuggestionKey); the popup is a separate view
// (ui/iconPicker/suggestionPopup.ts) that renders it. While the list is open the editor element
// (role textbox) carries aria-autocomplete, aria-controls and aria-activedescendant, so screen
// readers follow the highlighted option while focus stays in the text. (aria-expanded is not
// allowed on a textbox.)
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { iconByName, searchIcons, type IconEntry } from './catalog';

/** Options shown in the list. */
export const SUGGESTION_LIMIT = 8;
/** Characters of the query (after the colon) before the list opens. */
export const MIN_QUERY = 2;

export interface IconSuggestionState {
  active: boolean;
  /** position of the `:` */
  from: number;
  /** the caret (end of the query) */
  to: number;
  query: string;
  results: readonly IconEntry[];
  /** highlighted option */
  index: number;
  /** a `:` position the user dismissed with Escape (stays closed until another `:`) */
  dismissed: number | null;
}

const INACTIVE: IconSuggestionState = { active: false, from: 0, to: 0, query: '', results: [], index: 0, dismissed: null };

export const iconSuggestionKey = new PluginKey<IconSuggestionState>('hbIconSuggestion');

type Meta = { type: 'move'; index: number } | { type: 'dismiss' } | { type: 'close' };
const META = 'hbIconSuggestion';

/** The `:query` right before the caret, or null (start of text or after a space/bracket/quote). */
export function triggerBefore(state: EditorState): { from: number; to: number; query: string } | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $pos = sel.$from;
  const parent = $pos.parent;
  if (!parent.isTextblock || parent.type.spec.code || !parent.type.contentMatch.matchType(state.schema.nodes.icon!)) return null;
  if ($pos.marks().some((m) => m.type.spec.code)) return null;
  const start = Math.max(0, $pos.parentOffset - 48);
  const text = parent.textBetween(start, $pos.parentOffset, undefined, '\uFFFC');
  const m = /(?:^|[\s([{"'\u00A0])(:([a-z0-9_]*))$/i.exec(text);
  if (!m) return null;
  const query = m[2]!;
  return { from: $pos.pos - m[1]!.length, to: $pos.pos, query };
}

function compute(state: EditorState, prev: IconSuggestionState): IconSuggestionState {
  const trigger = triggerBefore(state);
  if (!trigger || trigger.query.length < MIN_QUERY) return prev.active || prev.dismissed !== null ? { ...INACTIVE, dismissed: trigger ? prev.dismissed : null } : prev;
  if (prev.dismissed === trigger.from) return { ...INACTIVE, dismissed: prev.dismissed };
  const results = searchIcons(trigger.query, { limit: SUGGESTION_LIMIT }).results;
  if (results.length === 0) return { ...INACTIVE, dismissed: prev.dismissed };
  const sameQuery = prev.active && prev.from === trigger.from && prev.query === trigger.query;
  return { active: true, ...trigger, results, index: sameQuery ? Math.min(prev.index, results.length - 1) : 0, dismissed: null };
}

/** The icon node for an entry. */
export function iconNode(state: EditorState, icon: Pick<IconEntry, 'font' | 'glyph'>): PMNode | null {
  return state.schema.nodes.icon?.create({ font: icon.font, glyph: icon.glyph }) ?? null;
}

/** Replaces `:query` (from..to) with the icon (one transaction). */
export function insertIconAt(state: EditorState, from: number, to: number, icon: Pick<IconEntry, 'font' | 'glyph'>): Transaction | null {
  const node = iconNode(state, icon);
  if (!node) return null;
  // Its own undo step, not merged with the typing of the query before it.
  const tr = closeHistory(state.tr).replaceRangeWith(from, to, node);
  tr.setMeta(META, { type: 'close' } satisfies Meta);
  return tr.scrollIntoView();
}

/** Inserts the highlighted option (or `index`) of the open list. */
export function acceptSuggestion(view: EditorView, index?: number): boolean {
  const s = iconSuggestionKey.getState(view.state);
  if (!s?.active) return false;
  const icon = s.results[index ?? s.index];
  if (!icon) return false;
  const tr = insertIconAt(view.state, s.from, s.to, icon);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}

export function moveSuggestion(view: EditorView, index: number): void {
  const s = iconSuggestionKey.getState(view.state);
  if (!s?.active || s.results.length === 0) return;
  const next = ((index % s.results.length) + s.results.length) % s.results.length;
  view.dispatch(view.state.tr.setMeta(META, { type: 'move', index: next } satisfies Meta));
}

export function dismissSuggestion(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(META, { type: 'dismiss' } satisfies Meta));
}

/** Ids the popup gives its listbox and options (for aria-controls / aria-activedescendant). */
export function suggestionIds(view: EditorView): { listbox: string; option: (i: number) => string } {
  let id = viewIds.get(view);
  if (!id) {
    id = `hb-icon-suggest-${Math.random().toString(36).slice(2, 8)}`;
    viewIds.set(view, id);
  }
  const base = id;
  return { listbox: base, option: (i) => `${base}-${i}` };
}
const viewIds = new WeakMap<EditorView, string>();

export function iconSuggestionPlugin(): Plugin<IconSuggestionState> {
  let pluginView: EditorView | null = null;
  return new Plugin<IconSuggestionState>({
    key: iconSuggestionKey,
    state: {
      init: () => INACTIVE,
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(META) as Meta | undefined;
        if (meta?.type === 'move') return prev.active ? { ...prev, index: meta.index } : prev;
        if (meta?.type === 'dismiss') return prev.active ? { ...INACTIVE, dismissed: prev.from } : prev;
        if (meta?.type === 'close') return { ...INACTIVE, dismissed: null };
        if (!tr.docChanged && !tr.selectionSet) return prev;
        return compute(state, prev);
      },
    },
    view(view) {
      pluginView = view;
      return {
        destroy() {
          pluginView = null;
        },
      };
    },
    props: {
      handleKeyDown(view, event) {
        const s = iconSuggestionKey.getState(view.state);
        if (!s?.active || event.isComposing) return false;
        switch (event.key) {
          case 'ArrowDown':
            moveSuggestion(view, s.index + 1);
            return true;
          case 'ArrowUp':
            moveSuggestion(view, s.index - 1);
            return true;
          case 'Enter':
          case 'Tab':
            if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
            return acceptSuggestion(view);
          case 'Escape':
            dismissSuggestion(view);
            return true;
          default:
            return false;
        }
      },
      // `:name:` with a known name: the icon at once (upstream's markdown syntax).
      handleTextInput(view, from, to, text) {
        if (text !== ':' || from !== to) return false;
        const trigger = triggerBefore(view.state);
        if (!trigger || trigger.to !== from || !trigger.query) return false;
        const icon = iconByName(trigger.query);
        if (!icon) return false;
        const tr = insertIconAt(view.state, trigger.from, from, icon);
        if (!tr) return false;
        view.dispatch(tr);
        return true;
      },
      attributes(state): Record<string, string> {
        const s = iconSuggestionKey.getState(state);
        if (!s?.active || !pluginView) return {};
        const ids = suggestionIds(pluginView);
        return {
          'aria-autocomplete': 'list',
          'aria-controls': ids.listbox,
          'aria-activedescendant': ids.option(s.index),
        };
      },
    },
  });
}
