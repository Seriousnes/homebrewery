// The /dev/panels document: twelve hand-laid pages (no pagination by default) covering every
// outline rule of upstream's header navigation:
//   p1  front cover with an h1             → "Page 1 - Cover: The Wandering Inn"
//   p2  table of contents (toc node)       → "Page 2 - Table of Contents"
//   p3  h1, h2, h3 mid-page, h4            → headings with depth
//   p4  a note block (nested h3: not listed), a stat block (nested h2: listed)
//   p5  a paragraph with an author id      → depth-7 entry "custom-anchor"
//   p6  inside cover without an h1         → "Page 6 - Interior Cover Page"
//   p7  h1 + h2 (long text)
//   p8  a very long heading                → ellipsis in the panel
//   p9  part cover with an h1              → "Page 9 - Section: Part Two: Below"
//   p10 h1 + h2
//   p11 h2 + h5 + h6
//   p12 back cover without an h1           → "Page 12 - Rear Cover Page"
import type { JSONContent } from '@tiptap/core';

const t = (text: string): JSONContent => ({ type: 'text', text });
const p = (text: string, attrs?: Record<string, unknown>): JSONContent => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: [t(text)] });
const h = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const block = (classes: string[], content: JSONContent[]): JSONContent => ({ type: 'themeBlock', attrs: { classes }, content });
const page = (content: JSONContent[], attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'page',
  attrs: { kind: 'manual', ...attrs },
  content,
});

const SENTENCES = [
  'The inn stands where three roads meet, though travellers never agree on which roads they were.',
  'Its common room is warm in winter and cool in summer, and the fire never needs feeding.',
  'Guests who stay a second night find their rooms slightly larger than they remember.',
  'The cellar holds casks older than the building, labelled in a hand nobody can read.',
  'A brass bell over the bar rings on its own whenever someone lies about their name.',
  'The stable boy knows every horse by name, even those that arrived an hour ago.',
];

/** Deterministic text of about `chars` characters. */
export function text(chars: number, from = 0): string {
  let out = '';
  for (let k = from; out.length < chars; k++) out += (out ? ' ' : '') + SENTENCES[k % SENTENCES.length];
  return out;
}

export const LONG_HEADING = 'A heading that is much longer than forty characters, so the outline shows an ellipsis';

export const PANEL_TEST_IDS = {
  customAnchor: 'custom-anchor',
} as const;

export const panelsDoc: JSONContent = {
  type: 'doc',
  content: [
    page([h(1, 'The Wandering Inn'), p('A guide to the inn that is never in the same place twice.')], { markers: ['frontCover'] }),
    page([{ type: 'toc' }]),
    page([h(1, 'Introduction'), p(text(500)), h(2, 'Using This Book'), p(text(700, 1)), h(3, 'Conventions'), p(text(600, 2)), h(4, 'Dice'), p(text(300, 3))]),
    page([
      h(2, 'The Common Room'),
      p(text(400, 1)),
      block(['note'], [h(3, 'A Note on Prices'), p(text(200, 2))]),
      p(text(300, 3)),
      block(['monster', 'frame'], [h(2, 'Innkeeper'), p('Medium fey, neutral'), p(text(250, 4))]),
    ]),
    page([p(text(500, 2)), p('This paragraph carries an author id.', { id: PANEL_TEST_IDS.customAnchor }), p(text(600, 3))]),
    page([p('Inside cover', { classes: ['insideCover'] }), p(text(200, 4))]),
    page([h(1, 'Chapter 1: Arrival'), p(text(700, 5)), h(2, 'First Night'), p(text(800))]),
    page([h(2, LONG_HEADING), p(text(900, 1))]),
    page([h(1, 'Part Two: Below'), p('What lies beneath the cellar.')], { markers: ['partCover'] }),
    page([h(1, 'Chapter 2: The Cellar'), p(text(600, 2)), h(2, 'Old Casks'), p(text(700, 3))]),
    page([h(2, 'Appendix'), p(text(400, 4)), h(5, 'Small Print'), p(text(200, 5)), h(6, 'Smaller Print'), p(text(200))]),
    page([p('Thanks for reading.')], { markers: ['backCover'] }),
  ],
};

/** A longer document for manual checks: `copies` repetitions of the ordinary pages. */
export function longDoc(copies = 8): JSONContent {
  const ordinary = (panelsDoc.content ?? []).slice(2, 5);
  const content: JSONContent[] = [...(panelsDoc.content ?? []).slice(0, 2)];
  for (let i = 0; i < copies; i++) content.push(...structuredClone(ordinary));
  return { type: 'doc', content };
}
