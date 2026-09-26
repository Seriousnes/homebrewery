// The hand-built document of /dev/schema: page 1 exercises the CSS contract (drop cap, note,
// stat block, wide block, table, column break, inline nodes), pages 2 and 3 hold one paragraph
// each that is far too long for the page, for the overflow-column check (plan §4.2).
import type { JSONContent } from '@tiptap/core';

const t = (text: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text, marks } : { type: 'text', text });
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });
const h = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const cell = (type: 'tableHeader' | 'tableCell', text: string, attrs: Record<string, unknown> = {}): JSONContent => ({
  type,
  attrs,
  content: [p(t(text))],
});

const SENTENCES = [
  'Travelers speak of an inn that is never in the same place twice.',
  'The common room smells of cedar, pipe smoke and rain that never falls outside.',
  'Its keeper greets every guest by name, though none remember telling it.',
  'Doors on the upper floor open onto corridors that were not there the night before.',
  'Those who pay in silver sleep soundly; those who pay in secrets sleep longer.',
  'On the longest night of the year the cellar door stands open, and something below hums.',
];

/** Deterministic filler text of at least `chars` characters. */
export function fillerText(chars: number): string {
  let text = '';
  for (let i = 0; text.length < chars; i++) text += (text ? ' ' : '') + SENTENCES[i % SENTENCES.length];
  return text;
}

export const OVERFLOW_TWO_COLUMNS = 'overflow-2col';
export const OVERFLOW_ONE_COLUMN = 'overflow-1col';

export const schemaDevDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'page',
      attrs: { kind: 'manual', pageNumber: true, footer: 'Schema dev page' },
      content: [
        h(1, 'The Wandering Inn'),
        p(t(fillerText(420))),
        p(t('A second paragraph, indented by the theme’s p + p rule. '), t('Bold', [{ type: 'bold' }]), t(', '), t('italic', [{ type: 'italic' }]), t(', '), t('super', [{ type: 'superscript' }]), t(' and '), t('sub', [{ type: 'subscript' }]), t('. Roll '), { type: 'icon', attrs: { font: 'df', glyph: 'd20-20' } }, t(' then '), t('a span', [{ type: 'span', attrs: { style: 'color: darkred;' } }]), t('.')),
        {
          type: 'themeBlock',
          attrs: { classes: ['note'] },
          content: [h(5, 'Rumors'), p(t('The innkeeper never ages, and the stew is always exactly warm enough.'))],
        },
        {
          type: 'themeBlock',
          attrs: { classes: ['monster', 'frame'] },
          content: [
            h(2, 'Innkeeper'),
            p(t('Medium fey, neutral', [{ type: 'italic' }])),
            { type: 'horizontalRule' },
            {
              type: 'definitionList',
              content: [
                { type: 'definitionTerm', content: [t('Armor Class', [{ type: 'bold' }])] },
                { type: 'definitionDesc', content: [t('15 (natural armor)')] },
                { type: 'definitionTerm', content: [t('Hit Points', [{ type: 'bold' }])] },
                { type: 'definitionDesc', content: [t('52 (8d8 + 16)')] },
                { type: 'definitionTerm', content: [t('Speed', [{ type: 'bold' }])] },
                { type: 'definitionDesc', content: [t('30 ft.')] },
              ],
            },
            { type: 'horizontalRule' },
            {
              type: 'table',
              content: [
                { type: 'tableRow', content: ['STR', 'DEX', 'CON'].map((s) => cell('tableHeader', s, { align: 'center' })) },
                { type: 'tableRow', content: ['10 (+0)', '14 (+2)', '14 (+2)'].map((s) => cell('tableCell', s, { align: 'center' })) },
              ],
            },
            { type: 'horizontalRule' },
            p(t('Timeless. ', [{ type: 'bold' }, { type: 'italic' }]), t('The innkeeper does not age and cannot be aged magically.')),
          ],
        },
        { type: 'columnBreak' },
        {
          type: 'themeBlock',
          attrs: { classes: ['wide'] },
          content: [p(t('A .wide block spans both columns.'))],
        },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'd6'), cell('tableHeader', 'Rumor', { colspan: 2 })] },
            { type: 'tableRow', content: [cell('tableCell', '1'), cell('tableCell', 'The cellar hums.'), cell('tableCell', 'true')] },
            { type: 'tableRow', content: [cell('tableCell', '2'), cell('tableCell', 'The stew is alive.'), cell('tableCell', 'false')] },
          ],
        },
        { type: 'spacer' },
        p(t('An image: '), { type: 'image', attrs: { src: '/assets/naturalCritLogoRed.svg', alt: 'logo', style: 'height: 1cm;' } }, t(' and a spacer box '), { type: 'inlineBox', attrs: { style: 'width: 1cm;' } }, t('.')),
        { type: 'toc', attrs: { depth: 3, wide: false, title: 'Contents' } },
      ],
    },
    {
      type: 'page',
      attrs: { kind: 'manual', pageNumber: true, footer: 'Two columns' },
      content: [
        h(2, 'Overflow in two columns'),
        { type: 'paragraph', attrs: { attributes: { 'data-testid': OVERFLOW_TWO_COLUMNS } }, content: [t(fillerText(9000))] },
      ],
    },
    {
      type: 'page',
      attrs: { kind: 'manual', columns: 1, pageNumber: true, footer: 'One column' },
      content: [
        h(2, 'Overflow in one column'),
        { type: 'paragraph', attrs: { attributes: { 'data-testid': OVERFLOW_ONE_COLUMN } }, content: [t(fillerText(9000))] },
      ],
    },
  ],
};
