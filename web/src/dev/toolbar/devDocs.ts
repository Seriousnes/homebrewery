// Documents for /dev/toolbar (plan §6.1, §6.2). Plain text, written for this page.
import type { JSONContent } from '@tiptap/core';

const t = (text: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const heading = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const item = (text: string): JSONContent => ({ type: 'listItem', content: [para(t(text))] });

/** Short sentences, numbered so every one is unique (tests select them by text). */
function filler(tag: string, sentences: number): string {
  const parts: string[] = [];
  for (let i = 0; i < sentences; i++) {
    parts.push(`${tag} sentence ${i} tells of lanterns, maps and a road that bends toward the hills.`);
  }
  return parts.join(' ');
}

/** One page: a heading, paragraphs, lists and a theme block. */
export function basicDoc(): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'page',
        attrs: { kind: 'manual' },
        content: [
          heading(1, 'The Wandering Inn'),
          para(t('Travelers speak of an inn that is never in the same place twice.')),
          para(t('The keeper '), t('Old Brannoc', [{ type: 'bold' }]), t(' pours cider for anyone who arrives before dusk.')),
          para(t('Guests may rent a room, a hammock, or a corner by the fire.')),
          { type: 'bulletList', content: [item('First rumor'), item('Second rumor'), item('Third rumor')] },
          { type: 'orderedList', attrs: { start: 1 }, content: [item('Step one'), item('Step two')] },
          { type: 'themeBlock', attrs: { classes: ['note'] }, content: [heading(5, 'A note'), para(t('Notes use the theme styling.'))] },
          para(t('The last paragraph of the page.')),
        ],
      },
    ],
  };
}

/** Enough text for several pages (pagination tests). */
export function longDoc(): JSONContent {
  const blocks: JSONContent[] = [heading(1, 'A Long Road')];
  for (let i = 0; i < 30; i++) blocks.push(para(t(filler(`Part${i}`, 6))));
  return { type: 'doc', content: [{ type: 'page', attrs: { kind: 'manual' }, content: blocks }] };
}

export const devDocs: Record<string, () => JSONContent> = { basic: basicDoc, long: longDoc };
