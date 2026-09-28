// Paragraphs, headings and the other simple block nodes. Built on the TipTap extensions (their
// commands, shortcuts and input rules come along) and extended for the CSS contract (§3.2).
import Blockquote from '@tiptap/extension-blockquote';
import CodeBlock from '@tiptap/extension-code-block';
import HardBreak from '@tiptap/extension-hard-break';
import Heading from '@tiptap/extension-heading';
import HorizontalRule from '@tiptap/extension-horizontal-rule';
import Paragraph from '@tiptap/extension-paragraph';
import { continuationAttribute } from '../attrs';
import { isGeneratedHeadingId } from '../slug';

export type ParagraphAlign = 'left' | 'right' | 'center' | 'justify';
const ALIGNS: readonly string[] = ['left', 'right', 'center', 'justify'];

/**
 * paragraph: inline content; align (upstream `:- -: :-:` paragraphs render `<p align="Center">`)
 * and continuation.
 */
export const HbParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      align: {
        default: null,
        validate: 'string|null',
        parseHTML: (el) => {
          const align = el.getAttribute('align')?.trim().toLowerCase() ?? '';
          return ALIGNS.includes(align) ? align : null;
        },
        // Capitalised like marked-alignment-paragraphs (the attribute is case-insensitive).
        renderHTML: (a) =>
          typeof a.align === 'string' && ALIGNS.includes(a.align)
            ? { align: a.align.charAt(0).toUpperCase() + a.align.slice(1) }
            : {},
      },
      continuation: continuationAttribute,
    };
  },
});

/**
 * heading: levels 1–6. `id` is the generic id attribute; the headingIds plugin fills it with a
 * unique slug unless `customId` is set (an id the author chose, e.g. `# Title {#intro}`).
 */
export const HbHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      level: { default: 1, validate: 'number', rendered: false },
      customId: {
        default: false,
        validate: 'boolean',
        keepOnSplit: false,
        // Imported HTML has no flag: an id that isn't the slug upstream generated for the heading
        // at its place in the document was set by the author (isGeneratedHeadingId).
        parseHTML: (el) => {
          if (el.hasAttribute('data-custom-id')) return true;
          const id = el.getAttribute('id');
          return id !== null && id !== '' && !isGeneratedHeadingId(el, id);
        },
        renderHTML: (a) => (a.customId === true ? { 'data-custom-id': '' } : {}),
      },
    };
  },
});

/** blockquote: block+ */
export const HbBlockquote = Blockquote;

/** codeBlock: pre › code.language-<language>, text only. */
export const HbCodeBlock = CodeBlock.configure({ languageClassPrefix: 'language-' });

/** horizontalRule: hr */
export const HbHorizontalRule = HorizontalRule;

/** hardBreak: br */
export const HbHardBreak = HardBreak;
