// Look of the Style drawer's CodeMirror editor. It follows the app's colour scheme: surface colours
// come from the UI kit tokens (--hbui-*), syntax colours from --hb-css-* custom properties that
// StyleDrawer.module.css sets for light and dark (both meet WCAG AA on their background). The
// `dark` flag only tells CodeMirror's base theme which defaults to use (selection, panels).
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

export function styleEditorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--hbui-color-text)',
        backgroundColor: 'var(--hbui-color-bg)',
        fontSize: '13px',
      },
      '&.cm-focused': { outline: '2px solid var(--hbui-color-focus)', outlineOffset: '-2px' },
      '.cm-scroller': { fontFamily: 'var(--hbui-font-mono)', lineHeight: '1.5' },
      '.cm-content': { caretColor: 'var(--hbui-color-text)', padding: '6px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--hbui-color-text)' },
      '.cm-gutters': {
        color: 'var(--hbui-color-text-muted)',
        backgroundColor: 'var(--hbui-color-surface)',
        borderRight: '1px solid var(--hbui-color-border)',
      },
      '.cm-activeLine': { backgroundColor: 'var(--hb-css-active-line)' },
      '.cm-activeLineGutter': { color: 'var(--hbui-color-text)', backgroundColor: 'var(--hbui-color-surface-hover)' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--hb-css-selection)',
      },
      '.cm-selectionMatch': { backgroundColor: 'var(--hb-css-match)' },
      '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--hb-css-match)', outline: '1px solid var(--hbui-color-border-strong)' },
      '.cm-tooltip': {
        color: 'var(--hbui-color-text)',
        backgroundColor: 'var(--hbui-color-surface-raised)',
        border: '1px solid var(--hbui-color-border)',
        borderRadius: 'var(--hbui-radius-sm)',
      },
      '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--hbui-font-mono)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
        color: 'var(--hbui-color-accent-text)',
        backgroundColor: 'var(--hbui-color-accent)',
      },
      '.cm-completionDetail': { color: 'inherit', opacity: '0.8' },
      '.cm-panels': { color: 'var(--hbui-color-text)', backgroundColor: 'var(--hbui-color-surface)' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--hbui-color-border)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--hbui-color-border)' },
      '.cm-textfield': {
        color: 'var(--hbui-color-text)',
        backgroundColor: 'var(--hbui-color-bg)',
        border: '1px solid var(--hbui-color-border-strong)',
      },
      '.cm-button': {
        color: 'var(--hbui-color-text)',
        backgroundImage: 'none',
        backgroundColor: 'var(--hbui-color-surface-raised)',
        border: '1px solid var(--hbui-color-border-strong)',
      },
      '.cm-searchMatch': { backgroundColor: 'var(--hb-css-match)', outline: '1px solid var(--hbui-color-border-strong)' },
      '.cm-foldPlaceholder': {
        color: 'var(--hbui-color-text-muted)',
        backgroundColor: 'var(--hbui-color-surface)',
        border: '1px solid var(--hbui-color-border)',
      },
    },
    { dark },
  );
}

/** Syntax colours for @lezer/css tokens (lang-css's styleTags), as CSS variables. */
export const styleHighlight = HighlightStyle.define([
  { tag: [t.definitionKeyword, t.keyword, t.operatorKeyword, t.modifier], color: 'var(--hb-css-keyword)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--hb-css-property)' },
  { tag: [t.string], color: 'var(--hb-css-string)' },
  { tag: [t.number, t.unit, t.color], color: 'var(--hb-css-number)' },
  { tag: [t.className, t.labelName, t.namespace], color: 'var(--hb-css-class)' },
  { tag: [t.tagName], color: 'var(--hb-css-tag)' },
  { tag: [t.atom], color: 'var(--hb-css-atom)' },
  { tag: [t.variableName], color: 'var(--hb-css-variable)' },
  { tag: [t.comment], color: 'var(--hb-css-comment)', fontStyle: 'italic' },
  { tag: [t.invalid], color: 'var(--hb-css-invalid)', textDecoration: 'underline wavy' },
]);
