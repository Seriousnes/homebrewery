// Names for theme blocks ({{monster,frame …}} → "Stat block"), shown by the theme-block label
// (plan §6.4). The label comes from the first class with a known name, in class order.

/** Known block classes → label. */
export const THEME_BLOCK_LABELS: Readonly<Record<string, string>> = {
  monster: 'Stat block',
  note: 'Note',
  descriptive: 'Descriptive',
  classTable: 'Class table',
  spellList: 'Spell list',
  quote: 'Quote',
  artist: 'Artist',
  runeTable: 'Rune table',
  index: 'Index',
  homebreweryCredits: 'Credits',
  pageNumber: 'Page number',
  footnote: 'Footnote',
  frontCover: 'Front cover',
  insideCover: 'Inside cover',
  partCover: 'Part cover',
  backCover: 'Back cover',
};

/** Classes whose theme styling has a frame variant (5ePHB: .monster.frame, .classTable.frame, .runeTable.frame). */
export const FRAMEABLE_CLASSES: ReadonlySet<string> = new Set(['monster', 'classTable', 'runeTable', 'spellList']);

/** "imageMaskEdge3" → "Image mask edge 3". */
export function humanizeClass(cls: string): string {
  const words = cls
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
}

const MODIFIERS = new Set(['wide', 'frame', 'decoration']);

/** The label of a theme block with `classes`. */
export function themeBlockLabel(classes: readonly string[]): string {
  for (const cls of classes) {
    const label = THEME_BLOCK_LABELS[cls];
    if (label) return label;
  }
  const main = classes.find((c) => !MODIFIERS.has(c));
  if (main) return humanizeClass(main) || 'Block';
  return classes.includes('wide') ? 'Wide block' : 'Block';
}

/** Whether the frame toggle applies to a block (a frameable class, or already framed). */
export const canFrame = (classes: readonly string[]): boolean => classes.includes('frame') || classes.some((c) => FRAMEABLE_CLASSES.has(c));
