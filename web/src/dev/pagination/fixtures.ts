// Documents for /dev/pagination: deterministic, hand-built, sized for 5ePHB pages.
import type { JSONContent } from '@tiptap/core';

const SENTENCES = [
  'Travelers speak of an inn that is never in the same place twice.',
  'The common room smells of cedar, pipe smoke and rain that never falls outside.',
  'Its keeper greets every guest by name, though none remember telling it.',
  'Doors on the upper floor open onto corridors that were not there the night before.',
  'Those who pay in silver sleep soundly; those who pay in secrets sleep longer.',
  'On the longest night of the year the cellar door stands open, and something below hums.',
  'A bard once tried to map the halls and was found, years later, humming the same tune.',
  'The stew is always exactly warm enough, and nobody has ever seen the cook.',
];

/** Deterministic filler text of about `chars` characters (whole sentences), starting at sentence `seed`. */
export function fillerText(chars: number, seed = 0): string {
  let text = '';
  for (let i = seed; text.length < chars; i++) text += (text ? ' ' : '') + SENTENCES[i % SENTENCES.length]!;
  return text;
}

export const t = (text: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text, marks } : { type: 'text', text });
export const p = (text: string, attrs?: Record<string, unknown>): JSONContent => ({
  type: 'paragraph',
  ...(attrs ? { attrs } : {}),
  ...(text ? { content: [t(text)] } : {}),
});
export const h = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [t(text)] });
export const li = (text: string): JSONContent => ({ type: 'listItem', content: [p(text)] });
export const ul = (...items: string[]): JSONContent => ({ type: 'bulletList', content: items.map(li) });
export const ol = (start: number, ...items: string[]): JSONContent => ({ type: 'orderedList', attrs: { start }, content: items.map(li) });
export const note = (title: string, text: string, classes = ['note']): JSONContent => ({
  type: 'themeBlock',
  attrs: { classes },
  content: [h(5, title), p(text)],
});
export const page = (content: JSONContent[], attrs: Record<string, unknown> = {}): JSONContent => ({ type: 'page', attrs, content });
export const doc = (...pages: JSONContent[]): JSONContent => ({ type: 'doc', content: pages });

/** `count` paragraphs of about `chars` characters each. */
export function paragraphs(count: number, chars: number, seed = 0): JSONContent[] {
  return Array.from({ length: count }, (_, i) => p(fillerText(chars, seed + i)));
}

/** A small mixed document: headings, paragraphs, a note, a list, a table, a wide block. */
function sample(): JSONContent {
  return doc(
    page(
      [
        h(1, 'The Wandering Inn'),
        ...paragraphs(4, 700),
        note('Rumors', fillerText(300, 3)),
        h(2, 'Rooms'),
        ol(1, ...Array.from({ length: 12 }, (_, i) => `Room ${i + 1}: ${fillerText(80, i)}`)),
        ...paragraphs(6, 600, 2),
        { type: 'themeBlock', attrs: { classes: ['wide'] }, content: [p(fillerText(400, 5))] },
        ...paragraphs(8, 650, 4),
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: ['d6', 'Encounter'].map((s) => ({ type: 'tableHeader', content: [p(s)] })) },
            ...Array.from({ length: 6 }, (_, i) => ({
              type: 'tableRow',
              content: [String(i + 1), fillerText(50, i)].map((s) => ({ type: 'tableCell', content: [p(s)] })),
            })),
          ],
        },
        ...paragraphs(6, 700, 1),
      ],
      { pid: 'sample01', columns: 2, pageNumber: true, footer: 'Pagination harness' },
    ),
  );
}

/** One 2-column section of about `pages` pages of plain paragraphs, stored as one manual page. */
export function longSection(pages: number, seed = 0): JSONContent {
  // 5ePHB 2-column page ≈ 6,500 characters of body text in 700-character paragraphs.
  const count = Math.round((pages * 6500) / 700);
  return doc(page([h(1, 'Chapter One'), ...paragraphs(count, 700, seed)], { pid: 'section1', columns: 2, pageNumber: true }));
}

/** Mixed content in three sections (2, 1 and 2 columns), about 20 pages. */
function mixed20(): JSONContent {
  const body = (seed: number, n: number): JSONContent[] =>
    Array.from({ length: n }, (_, i) => {
      const k = seed + i;
      if (k % 11 === 5) return h(3, `Section ${k}`);
      if (k % 13 === 7) return note(`Note ${k}`, fillerText(220, k));
      if (k % 9 === 4) return ul(...Array.from({ length: 3 + (k % 4) }, (_, j) => fillerText(60 + 10 * j, k + j)));
      if (k % 17 === 3) return ol(1, ...Array.from({ length: 4 }, (_, j) => fillerText(70, k + j)));
      return p(fillerText(250 + ((k * 97) % 600), k));
    });
  return doc(
    page([h(1, 'Part One'), ...body(0, 80)], { pid: 'mixed001', columns: 2, pageNumber: true }),
    page([h(1, 'Part Two'), ...body(80, 35)], { pid: 'mixed002', columns: 1, pageNumber: true }),
    page([h(1, 'Part Three'), ...body(115, 80)], { pid: 'mixed003', columns: 2, pageNumber: true }),
  );
}

/** Three sections of about two pages each (2, 1 and 2 columns), for the section commands. */
function sections(): JSONContent {
  return doc(
    page([h(1, 'Part One'), ...paragraphs(16, 700, 0)], { pid: 'sectionA', columns: 2, pageNumber: true, footer: 'Part One' }),
    page([h(1, 'Part Two'), ...paragraphs(7, 700, 3)], { pid: 'sectionB', columns: 1, pageNumber: true, footer: 'Part Two' }),
    page([h(1, 'Part Three'), ...paragraphs(16, 700, 5)], { pid: 'sectionC', columns: 2, pageNumber: true, footer: 'Part Three' }),
  );
}

/** A stat block taller than a column, an image taller than a column, a table taller than a column. */
function oversize(): JSONContent {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: 'tableRow',
      content: [String(i + 1), fillerText(60, i)].map((s) => ({ type: 'tableCell', content: [p(s)] })),
    }));
  return doc(
    page([h(1, 'Bestiary'), note('Ancient Dragon', fillerText(4200, 1), ['monster', 'frame'])], { pid: 'oversize1', columns: 2 }),
    page(
      [p(''), { type: 'paragraph', content: [{ type: 'image', attrs: { src: '/assets/catwarrior.jpg', width: 1200, height: 1800, style: 'width: 100%;' } }] }, p(fillerText(300, 2))],
      { pid: 'oversize2', columns: 2 },
    ),
    page([{ type: 'table', content: rows(60) }, p(fillerText(200, 4))], { pid: 'oversize3', columns: 2 }),
  );
}

export const FIXTURES: Record<string, () => JSONContent> = {
  sample,
  /** about 2.5 pages: page 1 full, for typing at the end of a full page */
  fill: () => longSection(2.5),
  long30: () => longSection(31),
  mixed20,
  sections,
  oversize,
};
