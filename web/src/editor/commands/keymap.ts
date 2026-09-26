// HbKeymap (plan §6.1, P3.4): the editor's keyboard shortcuts, and the actions the toolbar shares
// with them. Ported from the intent of upstream's markdownKeymap
// (legacy/client/components/codeEditor/extensions/customKeyMaps.js:235-273).
//
//   const extensions = useMemo(() => [...hbKeymapExtensions, Pagination.configure(…)], []);
//   <EditorCanvas extensions={extensions} … />
//   useEffect(() => onKeymapRequest(editor, (r) => r === 'save' ? (saveNow(), true) : false), [editor]);
//
// The final map ("Mod" is Ctrl, or Cmd on macOS). Formatting keys always consume the key press
// in an editable editor, so the browser's own shortcut (Ctrl+B bookmarks, Ctrl+U view source,
// Ctrl+= zoom, Ctrl+L address bar, Ctrl+K search …) never fires from inside the canvas.
//
//   Mod-B / Mod-I / Mod-U        bold / italic / underline
//   Shift-Mod-S, Mod-E           strikethrough, inline code (TipTap's keys, kept)
//   Shift-Mod-= / Mod-=          superscript / subscript (TipTap's Mod-. and Mod-, are removed)
//   Mod-.                        non-breaking space
//   Shift-Mod-. / Shift-Mod-,    widen / narrow the inlineBox spacer at the cursor (10% steps;
//                                widen inserts one when there is none; narrow at 10% removes it)
//   Mod-M                        span with classes: the class picker (request 'span')
//   Shift-Mod-M                  wrap in a theme block: the class picker (request 'themeBlock')
//   Mod-K                        link dialog (request 'link')
//   Mod-L / Shift-Mod-L          bullet / numbered list (TipTap's Shift-Mod-8 / Shift-Mod-7 kept)
//   Shift-Mod-1…6                heading 1…6 (toggles back to a paragraph)
//   Mod-Alt-0, Mod-Alt-1…6       paragraph, heading (TipTap's keys, kept)
//   Mod-Alt-C, Shift-Mod-B       code block, blockquote (TipTap's keys, kept)
//   Mod-Enter                    manual page break (commands/sections.ts insertPageBreak: starts a
//                                section). Replaces TipTap's hard break on Mod-Enter (Shift-Enter
//                                still is one); in a code block it leaves the block (exitCode)
//   Shift-Mod-Enter              column break
//   Mod-Z, Shift-Mod-Z, Mod-Y    undo, redo, redo (the UndoRedo extension's keys)
//   Tab / Shift-Tab              in a list item: sink / lift it, also across a page seam of a list
//                                pagination split (the key is consumed even when the item can't
//                                move); elsewhere not handled, so focus leaves the editor (no
//                                keyboard trap; tables keep their cell navigation, also in a list
//                                item; the ':' icon suggestion takes Tab while it is open)
//   Mod-S                        request 'save' (always consumed: no browser "Save page")
//   Mod-P                        request 'print' (the browser prints when nobody handles it)
//   Alt-F10                      request 'focusToolbar'
//   Mod-/                        nothing (the document model has no comments)
//
// A read-only editor consumes the formatting keys without acting (TipTap's own bindings would
// otherwise still format it), and opens no dialogs.
//
// Every action is exactly one undo step: runChain closes the undo group before and after the
// command (prosemirror-history's closeHistory), so neither the previous typing nor the next one
// merges into it.
import { Extension, type AnyExtension, type ChainedCommands, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Command } from '@tiptap/pm/state';
import { HbSubscript, HbSuperscript } from '../schema';
import {
  headingKind,
  inListItem,
  inTableCellOfList,
  insertColumnBreak,
  moveListItem,
  setAlign,
  setTextBlockKind,
  toggleTextBlockKind,
  unwrapThemeBlock,
  wrapInThemeBlock,
  type AlignValue,
  type TextBlockKind,
} from './blocks';
import { applyLink, applySpan, insertNbsp, narrowSpacer, removeLink, removeSpan, spanTarget, widenSpacer } from './marks';
import { insertPageBreak } from './sections';

// ---------------------------------------------------------------------------------------------
// requests: what the keymap can't do by itself (dialogs, saving, printing, toolbar focus)

export type KeymapRequest = 'save' | 'print' | 'span' | 'themeBlock' | 'link' | 'focusToolbar';

/** Return false to decline a request (the next listener, then the fallback, gets it). */
export type KeymapListener = (request: KeymapRequest) => boolean | void;

export interface HbKeymapStorage {
  listeners: Set<KeymapListener>;
}

declare module '@tiptap/core' {
  interface Storage {
    hbKeymap: HbKeymapStorage;
  }
}

function keymapStorage(editor: Editor): HbKeymapStorage | undefined {
  if (editor.isDestroyed) return undefined;
  return (editor.storage as Partial<Record<'hbKeymap', HbKeymapStorage>>).hbKeymap;
}

/**
 * Listens to the keymap's requests (Mod-S save, Mod-P print, Mod-M / Shift-Mod-M class picker,
 * Mod-K link dialog, Alt-F10 toolbar). The newest listener is asked first. Returns the
 * unsubscribe function. A no-op for an editor without HbKeymap.
 */
export function onKeymapRequest(editor: Editor, listener: KeymapListener): () => void {
  const storage = keymapStorage(editor);
  if (!storage) return () => {};
  storage.listeners.add(listener);
  return () => storage.listeners.delete(listener);
}

/**
 * Sends a request to the listeners (newest first). true when one handled it. The toolbar uses it
 * too, so its buttons open the same dialogs as the keys.
 */
export function emitKeymapRequest(editor: Editor, request: KeymapRequest): boolean {
  const storage = keymapStorage(editor);
  if (!storage) return false;
  for (const listener of [...storage.listeners].reverse()) {
    if (listener(request) !== false) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// running commands as one undo step each

/** Ends the current undo group: the next change starts a new undo step. */
export function closeUndoGroup(editor: Editor): void {
  if (editor.isDestroyed) return;
  editor.view.dispatch(closeHistory(editor.state.tr));
}

/**
 * Runs a TipTap chain as its own undo step (the group is closed before and after). No focus
 * change: keys run in the focused editor; toolbar buttons keep the focus where it is.
 */
export function runChain(editor: Editor, build: (chain: ChainedCommands) => ChainedCommands): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const chain = editor.chain().command(({ tr }) => {
    closeHistory(tr);
    return true;
  });
  const ok = build(chain).run();
  if (ok) closeUndoGroup(editor);
  return ok;
}

/** Runs a ProseMirror command (marks.ts, blocks.ts) as its own undo step. */
export function runCommand(editor: Editor, command: Command): boolean {
  return runChain(editor, (chain) => chain.command(({ state, dispatch }) => command(state, dispatch)));
}

/** Whether a ProseMirror command can run on the editor's current state (for disabled states). */
export function canRun(editor: Editor, command: Command): boolean {
  return !editor.isDestroyed && editor.isEditable && command(editor.state);
}

// ---------------------------------------------------------------------------------------------
// actions shared by keys and toolbar

export const editorActions = {
  bold: (e: Editor) => runChain(e, (c) => c.toggleBold()),
  italic: (e: Editor) => runChain(e, (c) => c.toggleItalic()),
  underline: (e: Editor) => runChain(e, (c) => c.toggleUnderline()),
  strike: (e: Editor) => runChain(e, (c) => c.toggleStrike()),
  code: (e: Editor) => runChain(e, (c) => c.toggleCode()),
  superscript: (e: Editor) => runChain(e, (c) => c.toggleSuperscript()),
  subscript: (e: Editor) => runChain(e, (c) => c.toggleSubscript()),
  nbsp: (e: Editor) => runCommand(e, insertNbsp),
  widenSpacer: (e: Editor) => runCommand(e, widenSpacer),
  narrowSpacer: (e: Editor) => runCommand(e, narrowSpacer),
  bulletList: (e: Editor) => runChain(e, (c) => c.toggleBulletList()),
  orderedList: (e: Editor) => runChain(e, (c) => c.toggleOrderedList()),
  /** Tab / Shift-Tab: also for items of lists that pagination split (blocks.ts moveListItem). */
  sinkListItem: (e: Editor) => runCommand(e, moveListItem('sink')),
  liftListItem: (e: Editor) => runCommand(e, moveListItem('lift')),
  blockquote: (e: Editor) => runChain(e, (c) => c.toggleBlockquote()),
  /**
   * Block type changes: history-safe, whole split paragraphs, attributes carried (blocks.ts
   * setTextBlockKind over commands/blockType.ts).
   */
  codeBlock: (e: Editor) => runChain(e, (c) => c.command(toggleTextBlockKind('codeBlock'))),
  paragraph: (e: Editor) => runChain(e, (c) => c.command(setTextBlockKind('paragraph'))),
  /** Shift-Mod-1…6: heading `level`, or back to a paragraph when it already is one. */
  toggleHeading: (e: Editor, level: 1 | 2 | 3 | 4 | 5 | 6) => runChain(e, (c) => c.command(toggleTextBlockKind(headingKind(level)))),
  /** The block-type menu. */
  setBlockKind: (e: Editor, kind: TextBlockKind) => runChain(e, (c) => c.command(setTextBlockKind(kind))),
  align: (e: Editor, align: AlignValue) => runCommand(e, setAlign(align)),
  /** Mod-Enter: commands/sections.ts insertPageBreak (false in a code block). */
  pageBreak: (e: Editor) => runCommand(e, insertPageBreak),
  columnBreak: (e: Editor) => runCommand(e, insertColumnBreak),
  applySpan: (e: Editor, classes: readonly string[]) => runCommand(e, applySpan(classes)),
  removeSpan: (e: Editor) => runCommand(e, removeSpan),
  wrapInThemeBlock: (e: Editor, classes: readonly string[]) => runCommand(e, wrapInThemeBlock(classes)),
  unwrapThemeBlock: (e: Editor) => runCommand(e, unwrapThemeBlock),
  applyLink: (e: Editor, href: string, text?: string) => runCommand(e, applyLink(href, text)),
  removeLink: (e: Editor) => runCommand(e, removeLink),
  undo: (e: Editor) => !e.isDestroyed && e.isEditable && e.commands.undo(),
  redo: (e: Editor) => !e.isDestroyed && e.isEditable && e.commands.redo(),
} as const;

// ---------------------------------------------------------------------------------------------
// the shortcut table (also the toolbar's tooltips and aria-keyshortcuts)

export type ShortcutId =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'superscript'
  | 'subscript'
  | 'nbsp'
  | 'widenSpacer'
  | 'narrowSpacer'
  | 'span'
  | 'themeBlock'
  | 'link'
  | 'bulletList'
  | 'orderedList'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'paragraph'
  | 'codeBlock'
  | 'blockquote'
  | 'pageBreak'
  | 'columnBreak'
  | 'undo'
  | 'redo'
  | 'sinkListItem'
  | 'liftListItem'
  | 'save'
  | 'print'
  | 'focusToolbar';

/** ProseMirror key names per shortcut; the first is the one shown in tooltips. */
export const HB_SHORTCUTS: Readonly<Record<ShortcutId, readonly string[]>> = {
  bold: ['Mod-b'],
  italic: ['Mod-i'],
  underline: ['Mod-u'],
  strike: ['Shift-Mod-s'],
  code: ['Mod-e'],
  superscript: ['Shift-Mod-='],
  subscript: ['Mod-='],
  nbsp: ['Mod-.'],
  widenSpacer: ['Shift-Mod-.'],
  narrowSpacer: ['Shift-Mod-,'],
  span: ['Mod-m'],
  themeBlock: ['Shift-Mod-m'],
  link: ['Mod-k'],
  bulletList: ['Mod-l', 'Shift-Mod-8'],
  orderedList: ['Shift-Mod-l', 'Shift-Mod-7'],
  heading1: ['Shift-Mod-1', 'Mod-Alt-1'],
  heading2: ['Shift-Mod-2', 'Mod-Alt-2'],
  heading3: ['Shift-Mod-3', 'Mod-Alt-3'],
  heading4: ['Shift-Mod-4', 'Mod-Alt-4'],
  heading5: ['Shift-Mod-5', 'Mod-Alt-5'],
  heading6: ['Shift-Mod-6', 'Mod-Alt-6'],
  paragraph: ['Mod-Alt-0'],
  codeBlock: ['Mod-Alt-c'],
  blockquote: ['Shift-Mod-b'],
  pageBreak: ['Mod-Enter'],
  columnBreak: ['Shift-Mod-Enter'],
  undo: ['Mod-z'],
  redo: ['Shift-Mod-z', 'Mod-y'],
  sinkListItem: ['Tab'],
  liftListItem: ['Shift-Tab'],
  save: ['Mod-s'],
  print: ['Mod-p'],
  focusToolbar: ['Alt-F10'],
};

/** Whether "Mod" means Cmd (macOS and iOS), as prosemirror-keymap decides. */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
}

const KEY_LABELS: Record<string, string> = { Enter: 'Enter', Tab: 'Tab' };

function keyParts(key: string): { mods: string[]; base: string } {
  const parts = key.split(/-(?!$)/);
  const base = parts.pop() ?? '';
  return { mods: parts, base };
}

/** Tooltip text for a ProseMirror key name: "Ctrl+Shift+=", or "⇧⌘=" on macOS. */
export function shortcutLabel(key: string, mac = isMacPlatform()): string {
  const { mods, base } = keyParts(key);
  const label = KEY_LABELS[base] ?? (base.length === 1 ? base.toUpperCase() : base);
  if (mac) {
    const symbols: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘', Meta: '⌘', Cmd: '⌘' };
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta', 'Cmd'];
    return [...order.filter((m) => mods.includes(m)).map((m) => symbols[m]), label].join('');
  }
  const names: Record<string, string> = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Meta', Cmd: 'Ctrl' };
  const order = ['Mod', 'Ctrl', 'Meta', 'Cmd', 'Alt', 'Shift'];
  return [...order.filter((m) => mods.includes(m)).map((m) => names[m]), label].join('+');
}

/** aria-keyshortcuts value for a ProseMirror key name: "Control+Shift+=" or "Meta+B". */
export function ariaKeyShortcut(key: string, mac = isMacPlatform()): string {
  const { mods, base } = keyParts(key);
  const names: Record<string, string> = { Mod: mac ? 'Meta' : 'Control', Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Meta: 'Meta', Cmd: 'Meta' };
  const order = ['Mod', 'Ctrl', 'Meta', 'Cmd', 'Alt', 'Shift'];
  const label = base === '+' ? 'Plus' : base.length === 1 ? base.toUpperCase() : base;
  return [...order.filter((m) => mods.includes(m)).map((m) => names[m]), label].join('+');
}

/** Tooltip text and aria-keyshortcuts for a shortcut id. */
export function shortcutFor(id: ShortcutId, mac = isMacPlatform()): { label: string; aria: string } {
  const key = HB_SHORTCUTS[id][0]!;
  return { label: shortcutLabel(key, mac), aria: HB_SHORTCUTS[id].map((k) => ariaKeyShortcut(k, mac)).join(' ') };
}

// ---------------------------------------------------------------------------------------------
// the extension

/**
 * Keymap priority: above every TipTap default, including Paragraph (priority 1000, whose Mod-Alt-0
 * would otherwise run first and reset the block's attributes through clearNodes), and above the
 * Sections extension (1100, commands/sections.ts), whose Mod-Enter would otherwise run the page
 * break without closing the undo group. ColumnNavigation (1000) only handles ArrowUp/ArrowDown,
 * keys this map leaves alone.
 */
export const HB_KEYMAP_PRIORITY = 1200;

export const HbKeymap = Extension.create<Record<string, never>, HbKeymapStorage>({
  name: 'hbKeymap',
  priority: HB_KEYMAP_PRIORITY,

  addStorage() {
    return { listeners: new Set<KeymapListener>() };
  },

  addKeyboardShortcuts() {
    const editor = this.editor;
    const shortcuts: Record<string, () => boolean> = {};
    /**
     * Formatting keys: run the action and consume the key. A read-only editor consumes them
     * without acting, so TipTap's own bindings (lower priority) can't format it either.
     */
    const bind = (id: ShortcutId, run: (e: Editor) => boolean) => {
      for (const key of HB_SHORTCUTS[id]) {
        shortcuts[key] = () => {
          if (editor.isEditable) run(editor);
          return true;
        };
      }
    };
    bind('bold', editorActions.bold);
    bind('italic', editorActions.italic);
    bind('underline', editorActions.underline);
    bind('strike', editorActions.strike);
    bind('code', editorActions.code);
    bind('superscript', editorActions.superscript);
    bind('subscript', editorActions.subscript);
    bind('nbsp', editorActions.nbsp);
    bind('widenSpacer', editorActions.widenSpacer);
    bind('narrowSpacer', editorActions.narrowSpacer);
    bind('bulletList', editorActions.bulletList);
    bind('orderedList', editorActions.orderedList);
    ([1, 2, 3, 4, 5, 6] as const).forEach((level) => bind(`heading${level}`, (e) => editorActions.toggleHeading(e, level)));
    bind('paragraph', editorActions.paragraph);
    bind('codeBlock', editorActions.codeBlock);
    bind('blockquote', editorActions.blockquote);
    bind('columnBreak', editorActions.columnBreak);
    // The class picker; without one (no listener), toggle a span / wrap in a plain theme block.
    bind('span', (e) => emitKeymapRequest(e, 'span') || (spanTarget(e.state) ? editorActions.removeSpan(e) : editorActions.applySpan(e, [])));
    bind('themeBlock', (e) => emitKeymapRequest(e, 'themeBlock') || editorActions.wrapInThemeBlock(e, []));

    for (const key of HB_SHORTCUTS.link) shortcuts[key] = () => editor.isEditable && emitKeymapRequest(editor, 'link');
    // In a code block the page break fails and the key goes on (TipTap's Mod-Enter leaves the block).
    for (const key of HB_SHORTCUTS.pageBreak) shortcuts[key] = () => !editor.isEditable || editorActions.pageBreak(editor);
    // Lists own Tab; elsewhere it moves focus on (tables handle it in their own keymap, also in a
    // table inside a list item; the icon suggestion, a higher priority, takes it while open).
    const listKey = (run: (e: Editor) => boolean) => () =>
      editor.isEditable && inListItem(editor.state) && !inTableCellOfList(editor.state) && (run(editor), true);
    shortcuts.Tab = listKey(editorActions.sinkListItem);
    shortcuts['Shift-Tab'] = listKey(editorActions.liftListItem);
    for (const key of HB_SHORTCUTS.save) {
      shortcuts[key] = () => {
        emitKeymapRequest(editor, 'save');
        return true;
      };
    }
    for (const key of HB_SHORTCUTS.print) shortcuts[key] = () => emitKeymapRequest(editor, 'print');
    for (const key of HB_SHORTCUTS.focusToolbar) shortcuts[key] = () => emitKeymapRequest(editor, 'focusToolbar');
    return shortcuts;
  },
});

/** TipTap binds Mod-. / Mod-, to superscript / subscript; this map uses other keys for them. */
const SuperscriptWithoutKeys = HbSuperscript.extend({ addKeyboardShortcuts: () => ({}) });
const SubscriptWithoutKeys = HbSubscript.extend({ addKeyboardShortcuts: () => ({}) });

/**
 * Pass these to buildEditorExtensions / EditorCanvas `extensions` (memoized). The superscript and
 * subscript entries replace the schema's marks by name, with the same schema and no keys.
 */
export const hbKeymapExtensions: readonly AnyExtension[] = [HbKeymap, SuperscriptWithoutKeys, SubscriptWithoutKeys];
