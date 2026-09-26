// Documents of /dev/canvas (S1, P3.2, P3.3).
//
// s1: the S1 spike document, two 2-column 5ePHB pages laid out by hand (no pagination):
//   page 1  h1 + drop-cap paragraph, paragraphs, .note, a table, a paragraph that runs from the
//           bottom of column 1 to the top of column 2 (split-para), a .monster.frame stat block
//           in upstream child order, and a last paragraph (page1-last)
//   page 2  first paragraph (page2-first), a .wide block, paragraphs, a column break, and the
//           paragraphs after it in column 2 (after-break)
// chrome: page chrome and counters: a front cover with page objects, numbered pages, a
//   skipCounting page and a resetCounting page.
// tall: boxes the theme keeps whole (li, blockquote: break-inside: avoid) that are taller than
//   a column, one per page. Firefox hung on these before canvas.css made .page a flex container.
// continued: list fragments as pagination leaves them (continuation = class hb-continued): a
//   continued ordered item, a continued item that restarts with its nested list (empty filler
//   paragraph), and one whose first paragraph has text.
import type { JSONContent } from '@tiptap/core';

const t = (text: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const b = (text: string): JSONContent => t(text, [{ type: 'bold' }]);
const i = (text: string): JSONContent => t(text, [{ type: 'italic' }]);
const p = (...content: JSONContent[]): JSONContent => ({
  type: 'paragraph',
  content,
});
const pid = (testId: string, ...content: JSONContent[]): JSONContent => ({
  type: 'paragraph',
  attrs: { attributes: { 'data-testid': testId } },
  content,
});
const h = (level: number, text: string): JSONContent => ({
  type: 'heading',
  attrs: { level },
  content: [t(text)],
});
const hr: JSONContent = { type: 'horizontalRule' };
const cell = (type: 'tableHeader' | 'tableCell', text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type,
  attrs,
  content: [p(t(text))],
});
const row = (type: 'tableHeader' | 'tableCell', cells: string[], attrs: Record<string, unknown> = {}): JSONContent => ({
  type: 'tableRow',
  content: cells.map((c) => cell(type, c, attrs)),
});

const SENTENCES = [
  'Travelers speak of an inn that is never in the same place twice.',
  'The common room smells of cedar, pipe smoke and rain that never falls outside.',
  'Its keeper greets every guest by name, though none remember telling it.',
  'Doors on the upper floor open onto corridors that were not there the night before.',
  'Those who pay in silver sleep soundly; those who pay in secrets sleep longer.',
  'On the longest night of the year the cellar door stands open, and something below hums.',
  'Bards claim the hearth fire has never gone out, not even when the river flooded the stables.',
  'A cat with one white ear follows the youngest guest from room to room and will not be fed.',
];

/** Deterministic filler text of about `chars` characters, starting at sentence `from`. */
export function filler(chars: number, from = 0): string {
  let text = '';
  for (let k = from; text.length < chars; k++) text += (text ? ' ' : '') + SENTENCES[k % SENTENCES.length];
  return text;
}

export const S1_TEST_IDS = {
  dropCap: 'dropcap',
  splitPara: 'split-para',
  page1Last: 'page1-last',
  page2First: 'page2-first',
  afterBreak: 'after-break',
  wide: 'wide-para',
} as const;

const statBlock: JSONContent = {
  type: 'themeBlock',
  attrs: { classes: ['monster', 'frame'] },
  content: [
    h(2, 'Innkeeper'),
    p(i('Medium fey, neutral')),
    hr,
    {
      type: 'definitionList',
      content: [
        { type: 'definitionTerm', content: [b('Armor Class')] },
        { type: 'definitionDesc', content: [t('15 (natural armor)')] },
        { type: 'definitionTerm', content: [b('Hit Points')] },
        { type: 'definitionDesc', content: [t('52 (8d8 + 16)')] },
        { type: 'definitionTerm', content: [b('Speed')] },
        { type: 'definitionDesc', content: [t('30 ft.')] },
      ],
    },
    hr,
    {
      type: 'table',
      content: [
        row('tableHeader', ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'], {
          align: 'center',
        }),
        row('tableCell', ['10 (+0)', '14 (+2)', '14 (+2)', '12 (+1)', '16 (+3)', '18 (+4)'], { align: 'center' }),
      ],
    },
    hr,
    {
      type: 'definitionList',
      content: [
        { type: 'definitionTerm', content: [b('Senses')] },
        { type: 'definitionDesc', content: [t('passive Perception 13')] },
        { type: 'definitionTerm', content: [b('Languages')] },
        {
          type: 'definitionDesc',
          content: [t('all, but rarely more than one at a time')],
        },
        { type: 'definitionTerm', content: [b('Challenge')] },
        { type: 'definitionDesc', content: [t('3 (700 XP)')] },
      ],
    },
    hr,
    p(b('Timeless.'), t(' The innkeeper does not age and cannot be aged magically.')),
    h(3, 'Actions'),
    p(
      b('Warm Welcome.'),
      t(' One creature the innkeeper can see must succeed on a DC 14 Wisdom saving throw or be charmed until it leaves the inn.'),
    ),
  ],
};

export const s1Doc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'page',
      attrs: { kind: 'manual', pageNumber: true, footer: 'The Wandering Inn' },
      content: [
        h(1, 'The Wandering Inn'),
        pid(S1_TEST_IDS.dropCap, t(filler(420))),
        p(t(filler(300, 2))),
        {
          type: 'themeBlock',
          attrs: { classes: ['note'] },
          content: [h(5, 'Rumors'), p(t('The innkeeper never ages, and the stew is always exactly warm enough.'))],
        },
        p(t(filler(160, 4))),
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [cell('tableHeader', 'd6', { align: 'center' }), cell('tableHeader', 'Rumor')],
            },
            ...['The cellar hums at night.', 'The stew is alive.', 'The keeper was a king.', 'Every door leads home.'].map((r, n) => ({
              type: 'tableRow',
              content: [cell('tableCell', String(n + 1), { align: 'center' }), cell('tableCell', r)],
            })),
          ],
        },
        pid(S1_TEST_IDS.splitPara, t(filler(1400, 1))),
        statBlock,
        pid(S1_TEST_IDS.page1Last, t(filler(120, 5))),
      ],
    },
    {
      type: 'page',
      attrs: { kind: 'auto', pageNumber: true, footer: 'The Wandering Inn' },
      content: [
        pid(S1_TEST_IDS.page2First, t(filler(360, 3))),
        {
          type: 'themeBlock',
          attrs: { classes: ['wide'] },
          content: [h(2, 'The Common Room'), pid(S1_TEST_IDS.wide, t('A .wide block spans both columns: '), t(filler(200, 6)))],
        },
        p(t(filler(400, 0))),
        p(t(filler(300, 5))),
        { type: 'columnBreak' },
        pid(S1_TEST_IDS.afterBreak, t(filler(300, 7))),
        p(t(filler(260, 2))),
      ],
    },
  ],
};

export const chromeDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'page',
      attrs: {
        kind: 'manual',
        markers: ['frontCover'],
        footer: 'A dev-page brew for the canvas lane.',
        objects: [
          {
            id: 'banner',
            kind: 'text',
            classes: ['banner'],
            style: '',
            text: 'HOMEBREW',
          },
          {
            id: 'cover-art',
            kind: 'image',
            classes: [],
            style: 'position:absolute;bottom:0;right:-400px;height:100%',
            src: '/assets/the_departure.webp',
          },
        ],
      },
      content: [h(1, 'The Wandering Inn'), h(2, 'A tavern that walks'), hr],
    },
    {
      type: 'page',
      attrs: { kind: 'manual', pageNumber: true, footer: 'Part 1 | Counted' },
      content: [h(1, 'Chapter One'), p(t(filler(600)))],
    },
    {
      type: 'page',
      attrs: {
        kind: 'manual',
        pageNumber: true,
        footer: 'Part 1 | skipCounting',
        markers: ['skipCounting'],
      },
      content: [h(2, 'An uncounted page'), p(t(filler(300, 3)))],
    },
    {
      type: 'page',
      attrs: {
        kind: 'manual',
        pageNumber: true,
        footer: 'Part 2 | resetCounting',
        markers: ['resetCounting'],
      },
      content: [h(1, 'Chapter Two'), p(t(filler(300, 5)))],
    },
    {
      type: 'page',
      attrs: { kind: 'auto', pageNumber: true, footer: 'Part 2 | Counted' },
      content: [p(t(filler(500, 1)))],
    },
  ],
};

/** blank: one page with one empty paragraph (paste target). */
export const blankDoc: JSONContent = {
  type: 'doc',
  content: [{ type: 'page', attrs: { kind: 'manual' }, content: [{ type: 'paragraph' }] }],
};

/** data-testid values of the tall and continued documents. */
export const LIST_TEST_IDS = {
  tallItem: 'tall-li',
  tallNested: 'tall-nested-li',
  tallQuote: 'tall-quote',
  tallOrdered: 'tall-ol-li',
  /** continued: ol(start 2) › li.hb-continued (text only) */
  contOrdered: 'cont-ol-li',
  /** continued: the item after it, number 3 */
  nextOrdered: 'next-ol-li',
  /** continued: ul › li.hb-continued › [p.hb-continued (empty filler), ul] */
  contFiller: 'cont-filler-li',
  /** continued: ul › li.hb-continued › [p.hb-continued with text, ul] */
  contText: 'cont-text-li',
  /** a whole item with a nested list, for comparison */
  whole: 'whole-li',
} as const;

const tid = (testId: string, attrs: Record<string, unknown> = {}): Record<string, unknown> => ({ ...attrs, attributes: { 'data-testid': testId } });
const cont = { continuation: true };
const item = (attrs: Record<string, unknown>, ...content: JSONContent[]): JSONContent => ({ type: 'listItem', attrs, content });
const bullets = (attrs: Record<string, unknown>, ...items: JSONContent[]): JSONContent => ({ type: 'bulletList', attrs, content: items });
const numbers = (attrs: Record<string, unknown>, ...items: JSONContent[]): JSONContent => ({ type: 'orderedList', attrs, content: items });
const emptyP = (attrs: Record<string, unknown> = {}): JSONContent => ({ type: 'paragraph', attrs });
const contP = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', attrs: cont, content });

/** tall: one box taller than a column per page (see the file comment). */
export const tallDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'page',
      attrs: { kind: 'manual' },
      content: [h(2, 'A list item taller than a column'), bullets({}, item(tid(LIST_TEST_IDS.tallItem), p(t(filler(4500)))), item({}, p(t('Second item.'))))],
    },
    {
      type: 'page',
      attrs: { kind: 'manual' },
      content: [
        h(2, 'A nested item taller than a column'),
        bullets({}, item({}, p(t('Short item.')), bullets({}, item(tid(LIST_TEST_IDS.tallNested), p(t(filler(4500, 1))))))),
      ],
    },
    {
      type: 'page',
      attrs: { kind: 'manual' },
      content: [h(2, 'A quote taller than a column'), { type: 'blockquote', attrs: tid(LIST_TEST_IDS.tallQuote), content: [p(t(filler(4500, 2)))] }],
    },
    {
      type: 'page',
      attrs: { kind: 'manual' },
      content: [
        h(2, 'An ordered item taller than a column'),
        numbers({ start: 1 }, item(tid(LIST_TEST_IDS.tallOrdered), p(t(filler(4500, 3)))), item({}, p(t('Second item.')))),
      ],
    },
  ],
};

/** continued: list fragments as pagination leaves them (see the file comment). */
export const continuedDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'page',
      attrs: { kind: 'manual' },
      content: [
        h(2, 'Continued list items'),
        p(t(filler(300))),
        numbers({ start: 1 }, item({}, p(t('First item.'))), item({}, p(t('The second item starts on the page before …')))),
      ],
    },
    {
      type: 'page',
      attrs: { kind: 'auto' },
      content: [
        numbers(
          { start: 2, continuation: true },
          item(tid(LIST_TEST_IDS.contOrdered, cont), contP(t('… and ends here, without a second number.'))),
          item(tid(LIST_TEST_IDS.nextOrdered), p(t('Third item.'))),
        ),
        p(t(filler(200, 2))),
        bullets(
          {},
          item(tid(LIST_TEST_IDS.whole), p(t('A whole item with a nested list:')), bullets({}, item({}, p(t('Nested one.'))), item({}, p(t('Nested two.'))))),
        ),
        bullets(
          cont,
          item(tid(LIST_TEST_IDS.contFiller, cont), emptyP(cont), bullets(cont, item({}, p(t('Its nested list continues here.'))))),
          item({}, p(t('The next outer item.'))),
        ),
        bullets(
          cont,
          item(tid(LIST_TEST_IDS.contText, cont), contP(t('The rest of an item’s own text,')), bullets({}, item({}, p(t('then its nested list.'))))),
        ),
      ],
    },
  ],
};

export const devDocs: Record<string, JSONContent> = {
  s1: s1Doc,
  chrome: chromeDoc,
  blank: blankDoc,
  tall: tallDoc,
  continued: continuedDoc,
};

/**
 * Page 1 of s1Doc as Homebrewery markdown (same text), for the legacy view of /dev/canvas: the
 * old renderer's output for the same content, to compare screenshots against (S1).
 * Differences that are the editor's by design: page number and footer are page chrome here and
 * `{{pageNumber,auto}}` / `{{footnote}}` spans in the flow upstream.
 */
export function s1Page1Markdown(): string {
  return [
    '# The Wandering Inn',
    filler(420),
    '',
    filler(300, 2),
    '',
    '{{note',
    '##### Rumors',
    'The innkeeper never ages, and the stew is always exactly warm enough.',
    '}}',
    '',
    filler(160, 4),
    '',
    '| d6 | Rumor |',
    '|:--:|------|',
    '| 1 | The cellar hums at night. |',
    '| 2 | The stew is alive. |',
    '| 3 | The keeper was a king. |',
    '| 4 | Every door leads home. |',
    '',
    filler(1400, 1),
    '',
    '{{monster,frame',
    '## Innkeeper',
    '*Medium fey, neutral*',
    '___',
    '**Armor Class** :: 15 (natural armor)',
    '**Hit Points** :: 52 (8d8 + 16)',
    '**Speed** :: 30 ft.',
    '___',
    '|  STR  |  DEX  |  CON  |  INT  |  WIS  |  CHA  |',
    '|:-----:|:-----:|:-----:|:-----:|:-----:|:-----:|',
    '|10 (+0)|14 (+2)|14 (+2)|12 (+1)|16 (+3)|18 (+4)|',
    '___',
    '**Senses** :: passive Perception 13',
    '**Languages** :: all, but rarely more than one at a time',
    '**Challenge** :: 3 (700 XP)',
    '___',
    '**Timeless.** The innkeeper does not age and cannot be aged magically.',
    '',
    '### Actions',
    '**Warm Welcome.** One creature the innkeeper can see must succeed on a DC 14 Wisdom saving throw or be charmed until it leaves the inn.',
    '}}',
    '',
    filler(120, 5),
    '',
    '{{pageNumber,auto}}',
    '{{footnote The Wandering Inn}}',
    '',
  ].join('\n');
}
