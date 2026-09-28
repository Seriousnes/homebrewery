// The "Text style" menu (toolbar block type menu, right-click menu): every block-level text style
// upstream's markdown could write, each item previewed in the active theme's style.
//
//   Text style (one of)   Paragraph, Heading 1–6 (# … ######), Code block (fences),
//                         Definition list (Term :: Definition)
//   Box (checkboxes)      Blockquote (>), and the theme boxes Note ({{note}}), Descriptive text
//                         box ({{descriptive}}) and Quote ({{quote}}): shown when the active theme
//                         (or the brew's CSS) styles their class, and always while the selection
//                         is in one (so it can be taken off).
//
// Marks (bold, italic, …), lists, alignment and tables have toolbar buttons of their own. Every
// item is one undo step.
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { ReactNode } from 'react';
import type { IconName, MenuEntry, MenuItem } from '@/ui';
import {
  blockKindOf,
  inBlockquote,
  setTextStyle,
  TEXT_STYLE_KINDS,
  TEXT_STYLE_LABELS,
  THEME_BOX_CLASSES,
  THEME_BOX_LABELS,
  type TextStyleKind,
  type ThemeBoxClass,
  themeBoxesAt,
  toggleThemeBox,
} from '../../commands/blocks';
import { editorActions, runChain, runCommand, shortcutFor, type ShortcutId } from '../../commands/keymap';
import { collectThemeClasses, type CollectThemeClassesOptions } from '../classPicker/themeClasses';
import { ThemePreview } from '../themePreview';
import styles from './textStyles.module.css';

export const TEXT_STYLE_ICONS: Record<TextStyleKind, IconName> = {
  paragraph: 'paragraph',
  heading1: 'heading1',
  heading2: 'heading2',
  heading3: 'heading3',
  heading4: 'heading',
  heading5: 'heading',
  heading6: 'heading',
  codeBlock: 'code',
  definitionList: 'outline',
};

const TEXT_STYLE_SHORTCUTS: Partial<Record<TextStyleKind, ShortcutId>> = {
  paragraph: 'paragraph',
  heading1: 'heading1',
  heading2: 'heading2',
  heading3: 'heading3',
  heading4: 'heading4',
  heading5: 'heading5',
  heading6: 'heading6',
  codeBlock: 'codeBlock',
};

/** The sample each item previews: the element the editor emits for the style (plan §3.2). */
function sampleOf(kind: TextStyleKind): ReactNode {
  const label = TEXT_STYLE_LABELS[kind];
  switch (kind) {
    case 'paragraph':
      return <p>{label}</p>;
    case 'heading1':
      return <h1>{label}</h1>;
    case 'heading2':
      return <h2>{label}</h2>;
    case 'heading3':
      return <h3>{label}</h3>;
    case 'heading4':
      return <h4>{label}</h4>;
    case 'heading5':
      return <h5>{label}</h5>;
    case 'heading6':
      return <h6>{label}</h6>;
    case 'codeBlock':
      return (
        <pre>
          <code>{label}</code>
        </pre>
      );
    case 'definitionList':
      return (
        <dl>
          <dt>Definition</dt>
          <dd>list</dd>
        </dl>
      );
  }
}

function boxSample(box: ThemeBoxClass | 'blockquote'): ReactNode {
  if (box === 'blockquote') {
    return (
      <blockquote>
        <p>Blockquote</p>
      </blockquote>
    );
  }
  return (
    <div className={`block ${box}`}>
      <p>{THEME_BOX_LABELS[box]}</p>
    </div>
  );
}

const preview = (sample: ReactNode, box = false) => <ThemePreview className={box ? styles.boxPreview : styles.preview}>{sample}</ThemePreview>;

// ---------------------------------------------------------------------------------------------
// which theme boxes the active theme styles

let styledCache: { key: readonly unknown[]; classes: ReadonlySet<string> } | null = null;

function ruleCount(sheet: CSSStyleSheet): number {
  try {
    return sheet.cssRules.length;
  } catch {
    return -1; // cross-origin
  }
}

/**
 * The theme boxes the document's canvas-scoped CSS (the active theme's stylesheets and the brew's
 * CSS) styles. Cached until the set of applied stylesheets changes.
 */
export function themeStyledBoxes(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): ThemeBoxClass[] {
  if (!doc) return [];
  const sheets = [...Array.from(doc.styleSheets), ...('adoptedStyleSheets' in doc ? doc.adoptedStyleSheets : [])].filter(
    (sheet) => !sheet.disabled && sheet.media.mediaText !== 'not all', // theme links load inert (themeLoader.ts)
  );
  const key = sheets.flatMap((sheet) => [sheet, ruleCount(sheet)]);
  if (!styledCache || styledCache.key.length !== key.length || styledCache.key.some((k, i) => k !== key[i])) {
    const found = collectThemeClasses({ sheets: sheets as unknown as NonNullable<CollectThemeClassesOptions['sheets']> });
    styledCache = { key, classes: new Set(found.map((c) => c.name)) };
  }
  const classes = styledCache.classes;
  return THEME_BOX_CLASSES.filter((cls) => classes.has(cls));
}

// ---------------------------------------------------------------------------------------------
// the entries

export interface TextStyleEntriesOptions {
  /** Runs after an item's command (default: focus the editor). */
  afterSelect?: () => void;
  /** Items show a live preview in the theme's style (default true); otherwise an icon and the label. */
  previews?: boolean;
  /** The theme boxes to offer (default: themeStyledBoxes()); a box the selection is in is always offered. */
  themeBoxes?: readonly ThemeBoxClass[];
}

/**
 * The "Text style" menu's entries for `state` (default: the editor's): a "Text style" group of
 * radio items and a "Box" group of checkbox items (see the file header). Build them when the menu
 * opens: the theme boxes offered depend on the stylesheets applied at that moment.
 */
export function textStyleEntries(editor: Editor, state: EditorState = editor.state, options: TextStyleEntriesOptions = {}): MenuEntry[] {
  const withPreviews = options.previews ?? true;
  const done =
    options.afterSelect ??
    (() => {
      if (!editor.isDestroyed) editor.view.focus();
    });
  const kind = blockKindOf(state);
  const inBoxes = themeBoxesAt(state);
  const offered = new Set<ThemeBoxClass>([...(options.themeBoxes ?? themeStyledBoxes()), ...inBoxes]);

  const styleItems: MenuItem[] = TEXT_STYLE_KINDS.map((k) => {
    const shortcut = TEXT_STYLE_SHORTCUTS[k];
    return {
      id: k,
      type: 'radio',
      label: TEXT_STYLE_LABELS[k],
      icon: withPreviews ? undefined : TEXT_STYLE_ICONS[k],
      content: withPreviews ? preview(sampleOf(k)) : undefined,
      shortcut: shortcut ? shortcutFor(shortcut).label : undefined,
      checked: kind === k,
      onSelect: () => {
        runChain(editor, (c) => c.command(setTextStyle(k)));
        done();
      },
    };
  });

  const boxItems: MenuItem[] = [
    {
      id: 'blockquote',
      type: 'checkbox',
      label: 'Blockquote',
      icon: withPreviews ? undefined : 'quote',
      content: withPreviews ? preview(boxSample('blockquote'), true) : undefined,
      shortcut: shortcutFor('blockquote').label,
      checked: inBlockquote(state),
      onCheckedChange: () => {
        editorActions.blockquote(editor);
        done();
      },
    },
    ...THEME_BOX_CLASSES.filter((cls) => offered.has(cls)).map(
      (cls): MenuItem => ({
        id: cls,
        type: 'checkbox',
        label: THEME_BOX_LABELS[cls],
        icon: withPreviews ? undefined : 'braces',
        content: withPreviews ? preview(boxSample(cls), true) : undefined,
        checked: inBoxes.includes(cls),
        onCheckedChange: () => {
          runCommand(editor, toggleThemeBox(cls));
          done();
        },
      }),
    ),
  ];

  return [
    { type: 'group', id: 'text-style', label: 'Text style', items: styleItems },
    { type: 'separator', id: 'text-style-separator' },
    { type: 'group', id: 'text-box', label: 'Box', items: boxItems },
  ];
}
