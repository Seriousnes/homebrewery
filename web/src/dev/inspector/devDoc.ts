// The /dev/inspector document: two sections (the first flows onto auto pages), a theme block, a
// stat block, a table, a list, a span, and page objects. Blocks carry data-testid attributes so
// the e2e specs can find them in the canvas.
import type { JSONContent } from '@tiptap/core';
import { filler } from '../canvas/devDocs';

const text = (value: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const node = (type: string, attrs?: Record<string, unknown>, content?: JSONContent[]): JSONContent => ({
  type,
  ...(attrs ? { attrs } : {}),
  ...(content ? { content } : {}),
});
const p = (value: string, testId?: string, attrs: Record<string, unknown> = {}): JSONContent =>
  node('paragraph', { ...attrs, ...(testId ? { attributes: { 'data-testid': testId } } : {}) }, value ? [text(value)] : undefined);

/** A small inline SVG, so the image object needs no network. */
const SKETCH =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140" viewBox="0 0 200 140"><rect width="200" height="140" rx="12" fill="#e8dcc0"/><path d="M20 120 L70 50 L110 95 L140 70 L180 120 Z" fill="#9c7b4b"/><circle cx="150" cy="35" r="14" fill="#c9a44c"/></svg>',
  );

export const INSPECTOR_TEST_IDS = {
  intro: 'p-intro',
  note: 'p-note',
  span: 'p-span',
  flow: 'p-flow',
  statName: 'p-stat',
  cell: 'p-cell',
  item: 'p-item',
  second: 'p-second',
} as const;

export const inspectorDoc: JSONContent = {
  type: 'doc',
  content: [
    node(
      'page',
      {
        columns: 2,
        pageNumber: true,
        footer: 'Part 1 | The Wandering Inn',
        objects: [
          { id: 'sketch', kind: 'image', src: SKETCH, classes: [], style: 'position: absolute; bottom: 60px; right: 60px; width: 200px;' },
          { id: 'credit', kind: 'text', text: 'Art: inn sketch', classes: ['artist'], style: 'position: absolute; bottom: 30px; right: 60px;' },
        ],
      },
      [
        node('heading', { level: 1 }, [text('The Wandering Inn')]),
        p('Travellers speak of an inn that is never in the same place twice.', INSPECTOR_TEST_IDS.intro),
        node('themeBlock', { classes: ['note'] }, [
          node('heading', { level: 5 }, [text('Rumours')]),
          p('The innkeeper never ages, and the stew is always warm.', INSPECTOR_TEST_IDS.note),
        ]),
        node('paragraph', { attributes: { 'data-testid': INSPECTOR_TEST_IDS.span } }, [
          text('Some words are '),
          text('set apart', [{ type: 'span', attrs: { classes: ['inspector-demo'] } }]),
          text(' with a span.'),
        ]),
        p(filler(9000), INSPECTOR_TEST_IDS.flow),
      ],
    ),
    node('page', {}, [
      node('heading', { level: 2 }, [text('Bestiary')]),
      node('themeBlock', { classes: ['monster', 'frame'] }, [
        node('heading', { level: 2 }, [text('Inn Mimic')]),
        p('Medium monstrosity, neutral', INSPECTOR_TEST_IDS.statName),
        node('horizontalRule'),
        node('table', undefined, [
          node('tableRow', undefined, [node('tableHeader', undefined, [p('STR')]), node('tableHeader', undefined, [p('DEX')])]),
          node('tableRow', undefined, [node('tableCell', undefined, [p('17 (+3)', INSPECTOR_TEST_IDS.cell)]), node('tableCell', undefined, [p('12 (+1)')])]),
        ]),
      ]),
      node('bulletList', undefined, [
        node('listItem', undefined, [p('Beware the stairs.', INSPECTOR_TEST_IDS.item)]),
        node('listItem', undefined, [p('Never tip the cat.')]),
      ]),
    ]),
    node('page', { markers: ['backCover'] }, [p('The end of the road.', INSPECTOR_TEST_IDS.second)]),
  ],
};
