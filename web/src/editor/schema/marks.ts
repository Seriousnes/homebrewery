// Marks: bold, italic, underline, strike, code, superscript, subscript, link and span.
//
// Note: @tiptap/extension-{bold,italic,strike,code} are installed as exact-version dependencies
// of @tiptap/starter-kit (3.31.3) and resolved from the hoisted node_modules; they should be
// added to web/package.json explicitly.
import { Mark } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import Italic from '@tiptap/extension-italic';
import Link, { type LinkOptions } from '@tiptap/extension-link';
import Strike from '@tiptap/extension-strike';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Underline from '@tiptap/extension-underline';
import { genericAttributes } from './attrs';
import { isSafeHref } from './html';
import { spanHasContent } from './nodes/inline';

export const HbBold = Bold; // strong (also parses b and font-weight styles)
export const HbItalic = Italic; // em (also parses i, except icons: the icon rule outranks it)
export const HbUnderline = Underline; // u
export const HbStrike = Strike; // s (also parses del from GFM ~~)
export const HbSuperscript = Superscript; // sup (^text^)
export const HbSubscript = Subscript; // sub (^^text^^)

/**
 * code: TipTap's code mark excludes every other mark; markdown allows **`bold code`** and
 * {{class `code`}}, so here code only excludes itself.
 */
export const HbCode = Code.extend({ excludes: 'code' });

/**
 * link: a[href]. No target/rel defaults (upstream links have none). Targets follow the server's
 * policy (isSafeHref: http, https, mailto, relative, #anchor): a link to anything else is not
 * parsed and renders without href; #p3 and #heading-id links are kept.
 */
export const LINK_DEFAULTS: Partial<LinkOptions> = {
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  HTMLAttributes: { target: null, rel: null, class: null },
  isAllowedUri: (url) => !url || isSafeHref(url),
};
export const createHbLink = (options: Partial<LinkOptions> = {}) => Link.configure({ ...LINK_DEFAULTS, ...options });

/**
 * span: `{{class,style,#id text}}` → span.inline-block with the generic attributes. excludes ''
 * so spans nest. It has the highest mark priority, which makes it the outermost mark: text runs
 * with other marks inside one span then render as one span.inline-block, never several.
 *
 * Only span.inline-block with content is a span mark; an empty one is an inlineBox, and a span
 * without the inline-block class has no rule (transparent: its children are kept).
 *
 * Known limit: two adjacent spans with identical attributes are one mark range in ProseMirror
 * and render as a single span.
 */
export const Span = Mark.create({
  name: 'span',
  priority: 1100,
  excludes: '',

  addAttributes() {
    return genericAttributes('span');
  },

  parseHTML() {
    return [
      {
        tag: 'span.inline-block',
        getAttrs: (el) => (spanHasContent(el) ? null : false),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { class: authorClass, ...rest } = HTMLAttributes as Record<string, unknown>;
    const cls = typeof authorClass === 'string' && authorClass !== '' ? `inline-block ${authorClass}` : 'inline-block';
    return ['span', { class: cls, ...rest }, 0];
  },
});
