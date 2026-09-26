// Documents for /dev/export (P6.4): what the HTML export has to carry over — page chrome (footer,
// page number, image and text objects), a live TOC (with a stat block heading the theme excludes),
// header rows, theme blocks, definition lists, same-origin images in the text, in page objects
// and in the brew CSS, links to pages, and optionally an image of another site.
import type { JSONContent } from '@tiptap/core';
import { chromeDoc, s1Doc } from '../canvas/devDocs';

/** A document and the brew CSS that goes with it. */
export interface ExportDevDoc {
  content: JSONContent;
  css: string;
}

const text = (value: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const p = (...content: (string | JSONContent)[]): JSONContent => ({ type: 'paragraph', content: content.map((c) => (typeof c === 'string' ? text(c) : c)) });
const h = (level: number, value: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const page = (content: JSONContent[], attrs?: Record<string, unknown>): JSONContent => ({ type: 'page', ...(attrs ? { attrs } : {}), content });
const cell = (type: 'tableHeader' | 'tableCell', value: string, attrs?: Record<string, unknown>): JSONContent => ({ type, ...(attrs ? { attrs } : {}), content: [p(value)] });
const row = (...cells: JSONContent[]): JSONContent => ({ type: 'tableRow', content: cells });
const bold = (value: string) => text(value, [{ type: 'bold' }]);
const italic = (value: string) => text(value, [{ type: 'italic' }]);

const FILLER =
  'Travelers speak of an inn that is never in the same place twice. The common room smells of cedar, pipe smoke and rain that never falls outside, and the keeper remembers every name. ';

/** Same-origin files (theme assets) the documents use; the export must write them in. */
export const EXPORT_ASSETS = {
  inlineImage: '/assets/catwarrior.jpg',
  objectImage: '/assets/naturalCritLogoRed.svg',
  cssImage: '/assets/discord.png',
} as const;

/** An image on another site (the export links it and lists it in its report). */
export const EXTERNAL_IMAGE = 'https://images.example.invalid/export-test/map.png';

const statBlock: JSONContent = {
  type: 'themeBlock',
  attrs: { classes: ['monster', 'frame'] },
  content: [
    h(2, 'Innkeeper'),
    p(italic('Medium fey, neutral')),
    { type: 'horizontalRule' },
    {
      type: 'definitionList',
      content: [
        { type: 'definitionTerm', content: [bold('Armor Class')] },
        { type: 'definitionDesc', content: [text('15 (natural armor)')] },
        { type: 'definitionTerm', content: [bold('Speed')] },
        { type: 'definitionDesc', content: [text('30 ft.')] },
      ],
    },
  ],
};

const rumorTable: JSONContent = {
  type: 'table',
  content: [
    row(cell('tableHeader', 'd4', { align: 'center' }), cell('tableHeader', 'Rumor')),
    row(cell('tableCell', '1', { align: 'center' }), cell('tableCell', 'The cellar hums at night.')),
    row(cell('tableCell', '2', { align: 'center' }), cell('tableCell', 'The stew is alive.')),
    row(cell('tableCell', '3', { align: 'center' }), cell('tableCell', 'The keeper was a king.')),
    row(cell('tableCell', '4', { align: 'center' }), cell('tableCell', 'Nobody has seen the stables.')),
  ],
};

function innPages(external: boolean): JSONContent[] {
  return [
    page(
      [
        h(1, 'The Exported Inn'),
        { type: 'toc', attrs: { depth: 3, wide: false, title: 'Contents' } },
        p(
          'A brew that leaves the site as one file. ',
          { type: 'image', attrs: { src: EXPORT_ASSETS.inlineImage, alt: 'A cat warrior', style: 'width: 120px;' } },
          ' It keeps its pictures, its fonts and its page numbers.',
        ),
        p(text('See '), text('the last page', [{ type: 'link', attrs: { href: '#p3' } }]), text(' for the way out.')),
        { type: 'paragraph', content: [text('A badge from the brew CSS: '), text('Discord', [{ type: 'span', attrs: { classes: ['exportBadge'] } }])] },
        p(FILLER),
      ],
      {
        pageNumber: true,
        footer: 'The Exported Inn',
        objects: [
          { id: 'o-logo', kind: 'image', classes: [], style: 'position: absolute; right: 60px; bottom: 90px; width: 90px;', src: EXPORT_ASSETS.objectImage },
          { id: 'o-note', kind: 'text', classes: [], style: 'position: absolute; left: 70px; bottom: 90px; font-size: 14px;', text: 'Printed at the inn' },
        ],
      },
    ),
    page(
      [
        h(2, 'Chapter One: Arrival'),
        p(FILLER + FILLER),
        { type: 'themeBlock', attrs: { classes: ['note'] }, content: [h(4, 'A Word of Warning'), p('Do not pay for the stew in silver.')] },
        rumorTable,
        h(3, 'The Common Room'),
        p(FILLER),
        statBlock,
        p(FILLER),
      ],
      { pageNumber: true, footer: 'The Exported Inn' },
    ),
    page(
      [
        h(2, 'Chapter Two: Departure'),
        p(FILLER),
        ...(external ? [p('A map from another site: ', { type: 'image', attrs: { src: EXTERNAL_IMAGE, alt: 'A map', style: 'width: 80px;' } })] : []),
        p(text('Back to '), text('the first page', [{ type: 'link', attrs: { href: '#p1' } }]), text('.')),
      ],
      { pageNumber: true, footer: 'The Exported Inn' },
    ),
  ];
}

const BADGE_CSS = `.page .exportBadge { padding-left: 22px; background: url('${EXPORT_ASSETS.cssImage}') no-repeat left center / 18px 18px; }`;

/** A5 pages (the theme's print snippet), no @page size of its own: the export adds it. */
const A5_CSS = `.page { width: 148mm; height: 210mm; padding: 1cm 1.2cm; }\n${BADGE_CSS}`;

export const exportDevDocs: Record<string, ExportDevDoc> = {
  inn: { content: { type: 'doc', content: innPages(false) }, css: BADGE_CSS },
  external: { content: { type: 'doc', content: innPages(true) }, css: BADGE_CSS },
  a5: { content: { type: 'doc', content: innPages(false) }, css: A5_CSS },
  s1: { content: s1Doc, css: '' },
  chrome: { content: chromeDoc, css: '' },
};
