// Light highlighting of Homebrewery markdown for the snippet body editor: headings, the block
// syntax ({{ … }}, \page, \column, ::: spacers), HTML tags and comments, links, bold and italics.
// A StreamLanguage (no full markdown grammar): it only colours, nothing depends on its tokens.
import { HighlightStyle, StreamLanguage, type StringStream } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

interface HbfmState {
  /** Inside an HTML comment that continues on the next line. */
  comment: boolean;
  /** Inside an HTML start or end tag (its attributes), up to its ">". */
  tag: boolean;
}

const HEADING = /^#{1,6}(\s|$)/;
const BREAK = /^\\(page|pagebreak|column|columnbreak|snippet)(\s|$)/;
const SPACER = /^:{3,}\s*$/;

function comment(stream: StringStream, state: HbfmState): string {
  while (!stream.eol()) {
    if (stream.match('-->')) {
      state.comment = false;
      return 'comment';
    }
    stream.next();
  }
  return 'comment';
}

export const hbfmLanguage = StreamLanguage.define<HbfmState>({
  name: 'hbfm',
  startState: () => ({ comment: false, tag: false }),
  token(stream, state) {
    if (state.comment) return comment(stream, state);
    if (state.tag) {
      // The tag's attributes are plain; its end is part of the tag.
      if (stream.match(/^\/?>/)) {
        state.tag = false;
        return 'tagName';
      }
      if (!stream.eatWhile(/[^/>]/)) stream.next();
      return null;
    }
    if (stream.sol()) {
      if (stream.match(HEADING, false)) {
        stream.skipToEnd();
        return 'heading';
      }
      if (stream.match(BREAK, false) || stream.match(SPACER, false)) {
        stream.skipToEnd();
        return 'keyword';
      }
    }
    if (stream.match('<!--')) {
      state.comment = true;
      return comment(stream, state);
    }
    if (stream.match(/^\{\{[^\s}]*/) || stream.match('}}')) return 'keyword';
    if (stream.match(/^<\/?[A-Za-z][\w-]*/)) {
      state.tag = true;
      return 'tagName';
    }
    if (stream.match(/^https?:\/\/[^\s)>\]]+/)) return 'url';
    if (stream.match(/^\*\*[^*\n]+\*\*/)) return 'strong';
    if (stream.match(/^\*[^*\s][^*\n]*\*/)) return 'emphasis';
    stream.next();
    stream.eatWhile(/[^<{}*\\h]/);
    return null;
  },
  languageData: { commentTokens: { block: { open: '<!--', close: '-->' } } },
});

/** Colours for hbfmLanguage's tokens (the --hb-css-* variables of the editor host). */
export const hbfmHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--hb-css-property)', fontWeight: 'bold' },
  { tag: t.keyword, color: 'var(--hb-css-keyword)' },
  { tag: t.comment, color: 'var(--hb-css-comment)', fontStyle: 'italic' },
  { tag: t.tagName, color: 'var(--hb-css-tag)' },
  { tag: t.url, color: 'var(--hb-css-atom)' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
]);
