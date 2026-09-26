// Documents for /dev/snippets (?doc=…).
import type { JSONContent } from '@tiptap/core';

const text = (value: string): JSONContent => ({ type: 'text', text: value });
const p = (value: string): JSONContent => (value ? { type: 'paragraph', content: [text(value)] } : { type: 'paragraph' });
const h = (level: number, value: string, attrs: Record<string, unknown> = {}): JSONContent => ({ type: 'heading', attrs: { level, ...attrs }, content: [text(value)] });
const page = (content: JSONContent[], attrs: Record<string, unknown> = {}): JSONContent => ({ type: 'page', attrs, content });
const doc = (...pages: JSONContent[]): JSONContent => ({ type: 'doc', content: pages });

/** Filler text: `n` sentences. */
export function filler(n: number, seed = 1): string {
  const words = ['the', 'inn', 'keeper', 'watches', 'a', 'storm', 'roll', 'over', 'distant', 'hills', 'while', 'travellers', 'argue', 'about', 'maps'];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = 8 + ((i * 7 + seed) % 9);
    const sentence = Array.from({ length: len }, (_, k) => words[(i * 3 + k * 5 + seed) % words.length]).join(' ');
    out.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.');
  }
  return out.join(' ');
}

const monster: JSONContent = {
  type: 'themeBlock',
  attrs: { classes: ['monster', 'frame'] },
  content: [
    h(2, 'Goblin'),
    { type: 'paragraph', content: [{ type: 'text', text: 'Small humanoid (goblinoid), neutral evil', marks: [{ type: 'italic' }] }] },
    { type: 'horizontalRule' },
    {
      type: 'definitionList',
      content: [
        { type: 'definitionTerm', content: [{ type: 'text', text: 'Armor Class', marks: [{ type: 'bold' }] }] },
        { type: 'definitionDesc', content: [text('15 (leather armor, shield)')] },
        { type: 'definitionTerm', content: [{ type: 'text', text: 'Hit Points', marks: [{ type: 'bold' }] }] },
        { type: 'definitionDesc', content: [text('7 (2d6)')] },
      ],
    },
    { type: 'horizontalRule' },
    p('Nimble Escape. The goblin can take the Disengage or Hide action as a bonus action.'),
  ],
};

const note: JSONContent = { type: 'themeBlock', attrs: { classes: ['note'] }, content: [h(5, 'A Note'), p('Notes use the theme frame.')] };

export const devDocs: Record<string, JSONContent> = {
  /** One empty page: snippets insert into it. */
  empty: doc(page([p('')])),
  /** A stat block and a note (theme-block labels). */
  blocks: doc(page([h(1, 'Bestiary'), p(filler(3)), monster, p(filler(2, 3)), note, p('After the note.')])),
  /**
   * A toc followed by chapters over several pages: a stat block's heading (--TOC exclude in
   * 5ePHB), an h4 (excluded by Blank's defaults), a page that skips counting and one that
   * restarts it.
   */
  toc: doc(
    page([{ type: 'toc', attrs: { depth: 6, wide: true, title: 'Contents' } }, h(1, 'Introduction'), p(filler(4))]),
    page([h(1, 'Chapter One'), p(filler(3)), h(2, 'The Inn'), p(filler(3)), monster, h(4, 'Minor Detail'), p(filler(2))]),
    page([h(2, 'Interlude'), p(filler(3))], { markers: ['skipCounting'] }),
    page([h(1, 'Chapter Two'), p(filler(3)), h(3, 'Deep Section'), p(filler(3))]),
    page([h(1, 'Appendix'), p(filler(2))], { markers: ['resetCounting'] }),
  ),
};
