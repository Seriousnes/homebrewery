// Documents for /dev/objects (P5.3, P5.5–P5.7).
import type { JSONContent } from '@tiptap/core';

/** An SVG image with a natural size, as a data: URL (no network in the specs). */
export function svgImage(width: number, height: number, fill = '#c33'): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${fill}"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#fff"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const IMAGE_200x100 = svgImage(200, 100);
export const IMAGE_120x160 = svgImage(120, 160, '#36c');

const text = (value: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const p = (value: string, attrs?: Record<string, unknown>): JSONContent => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: value ? [text(value)] : [] });
const page = (content: JSONContent[], attrs?: Record<string, unknown>): JSONContent => ({ type: 'page', ...(attrs ? { attrs } : {}), content });
const doc = (...pages: JSONContent[]): JSONContent => ({ type: 'doc', content: pages });
const cell = (type: 'tableHeader' | 'tableCell', value: string, attrs?: Record<string, unknown>): JSONContent => ({ type, ...(attrs ? { attrs } : {}), content: [p(value)] });
const row = (...cells: JSONContent[]): JSONContent => ({ type: 'tableRow', content: cells });

const FILLER =
  'Travelers speak of an inn that is never in the same place twice. The common room smells of cedar, pipe smoke and rain that never falls outside. ';

export const blankDoc = doc(page([{ type: 'heading', attrs: { level: 1 }, content: [text('The Wandering Inn')] }, p('Hello there, adventurer.'), p('A second paragraph.')]));

export const blocksDoc = doc(
  page([
    p('Paragraph one.'),
    { type: 'definitionList', content: [{ type: 'definitionTerm', content: [text('Speed')] }, { type: 'definitionDesc', content: [text('30 ft.')] }] },
    p('Paragraph two.'),
    { type: 'spacer' },
    p('Paragraph three.'),
    { type: 'horizontalRule' },
    p('Paragraph four.'),
    { type: 'columnBreak' },
    p('Paragraph five, in the second column.'),
  ]),
);

export const tablesDoc = doc(
  page([
    p('Before the table.'),
    {
      type: 'table',
      content: [
        row(cell('tableHeader', 'd6', { align: 'center' }), cell('tableHeader', 'Rumor')),
        row(cell('tableCell', '1', { align: 'center' }), cell('tableCell', 'The cellar hums at night.')),
        row(cell('tableCell', '2', { align: 'center' }), cell('tableCell', 'The stew is alive.')),
        row(cell('tableCell', '3', { align: 'center' }), cell('tableCell', 'The keeper was a king.')),
      ],
    },
    p('After the table.'),
  ]),
);

export const imagesDoc = doc(
  page([
    { type: 'paragraph', content: [text('An inline image '), { type: 'image', attrs: { src: IMAGE_200x100, alt: 'red' } }, text(' in the text.')] },
    { type: 'paragraph', content: [{ type: 'image', attrs: { src: IMAGE_120x160, alt: 'blue', style: 'float: right; width: 60px;' } }] },
    p('The paragraph after the floated image.'),
    { type: 'paragraph', content: [text('Sized by height only: '), { type: 'image', attrs: { src: IMAGE_200x100, alt: 'tall', style: 'height: 50px;', width: 200, height: 100 } }] },
  ]),
);

/**
 * Objects in the empty lower half of a page (img1, txt1) and one behind the text (behind:
 * 5ePHB puts images at z-index -1), for the pointer specs.
 */
export const objectsDoc = doc(
  page([p(FILLER), p(FILLER)], {
    objects: [
      { id: 'img1', kind: 'image', classes: [], style: 'position: absolute; left: 100px; top: 600px; width: 200px;', src: IMAGE_200x100 },
      { id: 'txt1', kind: 'text', classes: [], style: 'position: absolute; left: 100px; top: 800px; font-size: 24px; background: #ffe;', text: 'A text object' },
      { id: 'behind', kind: 'image', classes: [], style: 'position: absolute; left: 60px; top: 40px; width: 120px;', src: IMAGE_120x160 },
    ],
  }),
);

export const objectsDevDocs: Record<string, JSONContent> = {
  blank: blankDoc,
  blocks: blocksDoc,
  tables: tablesDoc,
  images: imagesDoc,
  objects: objectsDoc,
};
