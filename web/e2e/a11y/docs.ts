// Documents for the accessibility specs: a brew with every kind of content the editor's UI works
// on (headings, a theme block, a table, a list, a TOC, page objects), and one with a block too
// tall for its page (layout warnings).
const text = (value: string, marks?: unknown[]) => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const node = (type: string, attrs?: Record<string, unknown>, content?: unknown[]) => ({
  type,
  ...(attrs ? { attrs } : {}),
  ...(content ? { content } : {}),
});
const p = (value: string) => node('paragraph', undefined, value ? [text(value)] : undefined);

/** A small inline SVG, so the image object needs no network. */
export const SKETCH =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="140" viewBox="0 0 200 140"><rect width="200" height="140" rx="12" fill="#e8dcc0"/><path d="M20 120 L70 50 L110 95 L140 70 L180 120 Z" fill="#9c7b4b"/></svg>',
  );

export const TEXTS = {
  title: 'The Wandering Inn',
  intro: 'Travellers speak of an inn that is never in the same place twice.',
  note: 'The innkeeper never ages, and the stew is always warm.',
  cell: '17 (+3)',
  item: 'Beware the stairs.',
  last: 'The end of the road.',
} as const;

export const richDoc = {
  type: 'doc',
  content: [
    node(
      'page',
      {
        columns: 2,
        objects: [
          { id: 'sketch', kind: 'image', src: SKETCH, classes: [], style: 'position: absolute; bottom: 80px; right: 60px; width: 200px;' },
          { id: 'credit', kind: 'text', text: 'Art: inn sketch', classes: ['artist'], style: 'position: absolute; bottom: 40px; right: 60px;' },
        ],
      },
      [
        node('heading', { level: 1 }, [text(TEXTS.title)]),
        p(TEXTS.intro),
        node('themeBlock', { classes: ['note'] }, [node('heading', { level: 5 }, [text('Rumours')]), p(TEXTS.note)]),
        node('paragraph', undefined, [text('Some words are '), text('set apart', [{ type: 'span', attrs: { classes: ['inspector-demo'] } }]), text(' with a span.')]),
        node('paragraph', undefined, [text('A '), text('link to the vault', [{ type: 'link', attrs: { href: 'https://example.com/vault' } }]), text(' here.')]),
      ],
    ),
    node('page', {}, [
      node('heading', { level: 2 }, [text('Bestiary')]),
      node('table', undefined, [
        node('tableRow', undefined, [node('tableHeader', undefined, [p('STR')]), node('tableHeader', undefined, [p('DEX')])]),
        node('tableRow', undefined, [node('tableCell', undefined, [p(TEXTS.cell)]), node('tableCell', undefined, [p('12 (+1)')])]),
      ]),
      node('bulletList', undefined, [node('listItem', undefined, [p(TEXTS.item)]), node('listItem', undefined, [p('Never tip the cat.')])]),
    ]),
    node('page', {}, [node('toc', { depth: 3, wide: false, title: 'Contents' }), p(TEXTS.last)]),
  ],
};

const long = (n: number) => Array.from({ length: n }, (_, i) => `Line ${i + 1} of a block that cannot be split across pages.`).join(' ');

/** A theme block taller than a page: a layout warning with fixes. */
export const oversizeDoc = {
  type: 'doc',
  content: [node('page', {}, [node('heading', { level: 1 }, [text('Too tall')]), node('themeBlock', { classes: ['note'] }, [p(long(260))])])],
};

/** A list, then a table, then text: where Tab stays in the editor (indent, next cell). */
export const trapDoc = {
  type: 'doc',
  content: [
    node('page', {}, [
      node('bulletList', undefined, [node('listItem', undefined, [p('First item')]), node('listItem', undefined, [p('Second item')])]),
      node('table', undefined, [
        node('tableRow', undefined, [node('tableHeader', undefined, [p('Name')]), node('tableHeader', undefined, [p('Level')])]),
        node('tableRow', undefined, [node('tableCell', undefined, [p('Goblin')]), node('tableCell', undefined, [p('1')])]),
      ]),
      p('After the table.'),
    ]),
  ],
};
