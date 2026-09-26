// Lists: bulletList (ul), orderedList (ol[start]), listItem (li), and definition lists
// (dl › dt, dd). Every one carries `continuation` (class hb-continued) for fragments that
// pagination split.
import { Node } from '@tiptap/core';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import { continuationAttribute } from '../attrs';

export const HbBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), continuation: continuationAttribute };
  },
});

export const HbOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      start: {
        default: 1,
        validate: 'number',
        parseHTML: (el) => {
          const start = parseInt(el.getAttribute('start') ?? '', 10);
          return Number.isFinite(start) ? start : 1;
        },
        // ol renderHTML (TipTap) writes start only when it isn't 1.
      },
      continuation: continuationAttribute,
    };
  },
});

export const HbListItem = ListItem.extend({
  addAttributes() {
    return { ...this.parent?.(), continuation: continuationAttribute };
  },
});

/**
 * definitionList: dl › (dt | dd)+ ("Term :: Def" and the multi-line form).
 *
 * The theme sets `dl { white-space: pre-line }` with inline dt/dd, so upstream line breaks come
 * from the newline text marked-definition-lists writes between the elements. ProseMirror can't
 * keep text between dt/dd, so canvas.css recreates the breaks: after every dd, and in the
 * multi-line form (`multiline`, class hb-dl-multiline) after every dt as well.
 */
/** Whether a dl is upstream's multi-line form: a newline right after its first </dt>. */
function isMultilineDl(el: HTMLElement): boolean {
  return /^\s*\n/.test(el.querySelector(':scope > dt')?.nextSibling?.textContent ?? '');
}

/**
 * Adds the class hb-dl-multiline to every multi-line definition list under `root`.
 *
 * Call this on marked-hbfm output before handing it to TipTap's generateJSON / insertContent:
 * their HTML parsing (elementFromString) removes "\n" text nodes, and with them the only sign
 * of the multi-line form. ProseMirror's own DOMParser (clipboard) keeps them, and the parse
 * rule checks them directly.
 */
export function markMultilineDefinitionLists(root: ParentNode): void {
  for (const dl of Array.from(root.querySelectorAll<HTMLElement>('dl'))) {
    if (isMultilineDl(dl)) dl.classList.add('hb-dl-multiline');
  }
}

export const DefinitionList = Node.create({
  name: 'definitionList',
  group: 'block',
  content: '(definitionTerm | definitionDesc)+',

  addAttributes() {
    return {
      multiline: {
        default: false,
        validate: 'boolean',
        // Multi-line upstream output has a newline right after the first </dt>.
        parseHTML: (el) => el.classList.contains('hb-dl-multiline') || isMultilineDl(el),
        renderHTML: (a) => (a.multiline === true ? { class: 'hb-dl-multiline' } : {}),
      },
      continuation: continuationAttribute,
    };
  },

  parseHTML() {
    return [{ tag: 'dl' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['dl', HTMLAttributes, 0];
  },
});

export const DefinitionTerm = Node.create({
  name: 'definitionTerm',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return { continuation: continuationAttribute };
  },

  parseHTML() {
    return [{ tag: 'dt' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['dt', HTMLAttributes, 0];
  },
});

export const DefinitionDesc = Node.create({
  name: 'definitionDesc',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return { continuation: continuationAttribute };
  },

  parseHTML() {
    return [{ tag: 'dd' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['dd', HTMLAttributes, 0];
  },
});
