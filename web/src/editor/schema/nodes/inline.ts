// Inline nodes: image, icon and inlineBox. (hardBreak lives with the text blocks.)
import { Node } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { hbSrcDeclaration, isSafeSrc, RAW_HTML_WRAPPER_ATTR, rawHtmlToElement, sanitizeRawHtml } from '../html';

function dimension(value: string | null): number | null {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * image (inline): img[loading=lazy] with `--HB_src:url(<src>)` in front of the author's style,
 * exactly like marked-hbfm, so .wrapLeft / .wrapRight shape-outside keep working. The generic
 * `style` attribute holds only the author's part; parsing strips the generated declaration.
 *
 * width/height store the image's natural size when known (plan §6.6) and render as the
 * standard width/height attributes. Upstream images never had them, so imports leave them
 * null. (Rendering a stored natural size must not fix both dimensions when the author's style
 * sets only one; the image NodeView / canvas CSS owns that.) Sources follow the server's policy
 * (isSafeSrc): http, https, relative and data:image/*.
 */
export const HbImage = Image.extend({
  addAttributes() {
    return {
      src: {
        default: null,
        validate: 'string|null',
        parseHTML: (el) => {
          const src = el.getAttribute('src');
          return src !== null && isSafeSrc(src) ? src : null;
        },
      },
      alt: { default: null, validate: 'string|null', parseHTML: (el) => el.getAttribute('alt') },
      title: { default: null, validate: 'string|null', parseHTML: (el) => el.getAttribute('title') },
      width: {
        default: null,
        validate: 'number|null',
        parseHTML: (el) => dimension(el.getAttribute('width')),
      },
      height: {
        default: null,
        validate: 'number|null',
        parseHTML: (el) => dimension(el.getAttribute('height')),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (el) => (isSafeSrc(el.getAttribute('src') ?? '') ? null : false),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { style: _authorStyle, src: _src, ...rest } = HTMLAttributes as Record<string, unknown>;
    const src = typeof node.attrs.src === 'string' && isSafeSrc(node.attrs.src) ? node.attrs.src : '';
    const authorStyle = typeof node.attrs.style === 'string' ? node.attrs.style.trim() : '';
    const style = src ? [hbSrcDeclaration(src), authorStyle].filter(Boolean).join(' ') : authorStyle;
    return ['img', { loading: 'lazy', src, ...rest, style: style || null }];
  },
}).configure({ inline: true, allowBase64: false });

/**
 * Icon fonts (themes/fonts/iconFonts): Dice, Elderberry Inn, Game Icons, and Font Awesome with
 * every class its CSS styles (fontawesome-free.less): v5 fas/far/fab (the :fas_x: emoji), v6
 * fa-solid/fa-regular/fa-brands/fa-classic and v4 fa, as upstream brews write them in raw HTML.
 */
export const ICON_FONTS = ['df', 'ei', 'gi', 'fas', 'far', 'fab', 'fa', 'fa-solid', 'fa-regular', 'fa-brands', 'fa-classic'] as const;
export type IconFont = (typeof ICON_FONTS)[number];

/** The element's first class that is an icon font (class order is kept for rendering). */
function iconFont(el: HTMLElement): IconFont | null {
  return (Array.from(el.classList).find((c) => (ICON_FONTS as readonly string[]).includes(c)) as IconFont | undefined) ?? null;
}

/**
 * icon (inline atom): `:df_d12_2:` renders `<i class="df d12-2"></i>` (marked-emoji with the
 * name maps in themes/fonts/iconFonts/*.js). font = the first icon-font class, glyph = the other
 * classes in order, so `<i class="fa-solid fa-dragon">` renders back as written. Its rule
 * outranks italic's `<i>` rule.
 */
export const Icon = Node.create({
  name: 'icon',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      font: {
        default: 'df',
        validate: 'string',
        parseHTML: (el) => iconFont(el),
        renderHTML: () => ({}),
      },
      glyph: {
        default: '',
        validate: 'string',
        parseHTML: (el) => {
          const font = iconFont(el);
          return Array.from(el.classList)
            .filter((c) => c !== font)
            .join(' ');
        },
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'i',
        priority: 100,
        getAttrs: (el) => (iconFont(el) ? null : false),
      },
    ];
  },

  renderHTML({ node }) {
    const font = String(node.attrs.font);
    const glyph = String(node.attrs.glyph).trim();
    return ['i', { class: glyph ? `${font} ${glyph}` : font }];
  },
});

/**
 * Embedded (phrasing) elements the schema has no node for. Inside text they stay inline as
 * rawInline; elsewhere the block rawHtml takes them (RAW_HTML_TAGS).
 */
export const RAW_INLINE_TAGS = ['svg', 'math', 'video', 'audio', 'canvas', 'map', 'object', 'picture'] as const;
/** The textblocks whose inline content they can be part of (ParseRule context). */
const INLINE_PARENTS = 'paragraph/|heading/|definitionTerm/|definitionDesc/';
const isRawInlineTag = (el: Element): boolean => (RAW_INLINE_TAGS as readonly string[]).includes(el.localName);

function rawInlineAttrs(html: string): { html: string } | false {
  const clean = sanitizeRawHtml(html);
  return clean === '' ? false : { html: clean };
}

/**
 * rawInline (inline atom): the inline counterpart of rawHtml, for embedded elements inside text
 * (`<p>Roll <svg class="icon">…</svg> to hit</p>`), so the paragraph isn't split around a block
 * and the theme's `p + p` rules see the same paragraphs as upstream. `html` is sanitized like
 * rawHtml's; HTML that isn't one embedded element renders in `span[data-hb-raw]`.
 */
export const RawInline = Node.create({
  name: 'rawInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      html: {
        default: '',
        validate: 'string',
        // Set by the parse rules' getAttrs.
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: `span[${RAW_HTML_WRAPPER_ATTR}]`, priority: 5, getAttrs: (el) => rawInlineAttrs(el.innerHTML) },
      // Above the block rawHtml catch-alls (priority 1), and only inside text.
      ...RAW_INLINE_TAGS.map((tag) => ({ tag, priority: 2, context: INLINE_PARENTS, getAttrs: (el: HTMLElement) => rawInlineAttrs(el.outerHTML) })),
    ];
  },

  renderHTML({ node }) {
    const html = typeof node.attrs.html === 'string' ? node.attrs.html : '';
    if (typeof document === 'undefined') return ['span', { [RAW_HTML_WRAPPER_ATTR]: '' }];
    return rawHtmlToElement(html, document, { wrapper: 'span', keepRoot: isRawInlineTag });
  },
});

/** Whether a span.inline-block has content (then it is a span mark, else an inlineBox). */
export function spanHasContent(el: HTMLElement): boolean {
  return el.children.length > 0 || (el.textContent ?? '').trim() !== '';
}

/**
 * inlineBox (inline atom): an empty span.inline-block, e.g. `{{width:100px}}` spacers. The
 * classes, style, id and attributes are the generic attributes.
 */
export const InlineBox = Node.create({
  name: 'inlineBox',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  parseHTML() {
    return [
      {
        tag: 'span.inline-block',
        priority: 60,
        getAttrs: (el) => (spanHasContent(el) ? false : null),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const { class: authorClass, ...rest } = HTMLAttributes as Record<string, unknown>;
    const cls = typeof authorClass === 'string' && authorClass !== '' ? `inline-block ${authorClass}` : 'inline-block';
    return ['span', { class: cls, ...rest }];
  },
});
