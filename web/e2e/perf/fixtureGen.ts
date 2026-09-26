// Deterministic generators for the P8.1 performance fixtures (plan §4.10, §11 P8.1).
//
// Everything here is original, generated text: words from a small invented vocabulary strung
// into sentences by a seeded PRNG (lorem-style prose). No third-party text.
//
//   rawBrew150()   a ~150-page brew in the 5ePHB theme: a cover page (frontCover marker, an
//                  image object), a live table of contents, twelve 2-column chapters (headings,
//                  paragraphs, bullet and ordered lists, definition lists, tables, theme blocks:
//                  notes, descriptive boxes, stat blocks, a wide block; images with their natural
//                  width and height) and a 1-column appendix. Manual pages only (sections).
//   rawSection50() one 2-column section (a single manual page) of flowing prose that paginates to
//                  ~50 pages.
//
// The stored fixtures (web/e2e/fixtures/perf-150.json, perf-50.json) are these documents after
// pagination settled in Chromium (auto pages included, as a saved brew stores them); perf.spec.ts
// regenerates them with HB_PERF_GENERATE=1. The raw form is used for the "unpaginated load" case.
//
// Plain TypeScript without app imports: the e2e project can't import web/src.

export interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** mulberry32: a small seeded PRNG with values in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// An invented vocabulary (plain English function words plus made-up names and fantasy nouns).
const COMMON = [
  'the', 'a', 'of', 'and', 'to', 'in', 'is', 'that', 'it', 'with', 'as', 'for', 'on', 'was', 'by', 'at', 'from', 'but', 'or', 'which',
  'their', 'each', 'when', 'where', 'under', 'over', 'beyond', 'before', 'after', 'while', 'every', 'some', 'many', 'few', 'no', 'most',
];
const NOUNS = [
  'lantern', 'harbor', 'tower', 'river', 'market', 'cellar', 'gate', 'bridge', 'forest', 'ridge', 'shrine', 'caravan', 'garrison', 'well',
  'archive', 'orchard', 'quarry', 'lighthouse', 'monastery', 'vault', 'causeway', 'mill', 'watchfire', 'barrow', 'ferry', 'bell', 'loom',
  'compass', 'ledger', 'charter', 'banner', 'relic', 'storm', 'tide', 'ember', 'frost', 'rumor', 'oath', 'debt', 'map', 'key', 'song',
  'traveler', 'warden', 'smith', 'scribe', 'merchant', 'pilgrim', 'captain', 'hermit', 'envoy', 'courier', 'sentry', 'healer', 'guide',
];
const VERBS = [
  'guards', 'hides', 'remembers', 'watches', 'carries', 'follows', 'binds', 'wakes', 'answers', 'crosses', 'mends', 'trades', 'keeps',
  'forgets', 'shelters', 'summons', 'measures', 'records', 'darkens', 'gathers', 'unlocks', 'weathers', 'outlasts', 'echoes', 'favors',
];
const ADJECTIVES = [
  'old', 'quiet', 'hollow', 'gilded', 'broken', 'northern', 'restless', 'patient', 'crooked', 'ancient', 'narrow', 'distant', 'bright',
  'weathered', 'sunken', 'hidden', 'lonely', 'stubborn', 'silver', 'amber', 'ashen', 'verdant', 'salted', 'hushed', 'uneasy', 'wary',
];
const NAMES = [
  'Veyla', 'Orsk', 'Thandril', 'Mirelle', 'Casvane', 'Duro', 'Ilsabet', 'Quenn', 'Rhoswen', 'Tovar', 'Ysolde', 'Brannoc', 'Ferrow',
  'Kelsira', 'Morvain', 'Pellis', 'Saethe', 'Ulbric', 'Wendrel', 'Zarim', 'Aldwyn', 'Corrin', 'Hestra', 'Jorvik',
];
const PLACES = [
  'Greywater', 'Ashfen', 'Highmoor', 'Saltmarch', 'Duskhollow', 'Emberwick', 'Thornvale', 'Coldharbor', 'Mirewood', 'Stonereach',
  'Brightwell', 'Ravensmere', 'Oakshade', 'Windrest', 'Frostford', 'Lowbarrow',
];

/** Sentence and paragraph generator over one PRNG. */
export class Prose {
  private readonly rand: () => number;
  constructor(seed: number) {
    this.rand = prng(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.rand() * (max - min + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rand() * list.length)]!;
  }
  chance(p: number): boolean {
    return this.rand() < p;
  }
  word(): string {
    const r = this.rand();
    if (r < 0.34) return this.pick(COMMON);
    if (r < 0.6) return this.pick(NOUNS);
    if (r < 0.75) return this.pick(ADJECTIVES);
    if (r < 0.88) return this.pick(VERBS);
    if (r < 0.95) return this.pick(NAMES);
    return this.pick(PLACES);
  }
  /** One sentence of `min`–`max` words, capitalized, with the occasional comma. */
  sentence(min = 7, max = 22): string {
    const n = this.int(min, max);
    const words: string[] = [];
    for (let i = 0; i < n; i++) {
      let w = this.word();
      if (i > 2 && i < n - 2 && this.chance(0.07)) w += ',';
      words.push(w);
    }
    const s = words.join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1) + (this.chance(0.08) ? '!' : '.');
  }
  /** Sentences until about `chars` characters. */
  text(chars: number): string {
    let out = '';
    while (out.length < chars) out += (out ? ' ' : '') + this.sentence();
    return out;
  }
  title(words = 3): string {
    const parts: string[] = [];
    for (let i = 0; i < words; i++) parts.push(this.chance(0.5) ? this.pick(ADJECTIVES) : this.pick(NOUNS));
    parts.push(this.chance(0.5) ? `of ${this.pick(PLACES)}` : this.pick(NOUNS));
    return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  name(): string {
    return `${this.pick(NAMES)} of ${this.pick(PLACES)}`;
  }
}

// Node builders ---------------------------------------------------------------------------------

export const text = (value: string, marks?: JsonNode['marks']): JsonNode => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
export const para = (content: JsonNode[] | string, attrs?: Record<string, unknown>): JsonNode => {
  const inner = typeof content === 'string' ? (content ? [text(content)] : []) : content;
  return { type: 'paragraph', ...(attrs ? { attrs } : {}), ...(inner.length ? { content: inner } : {}) };
};
export const heading = (level: number, value: string): JsonNode => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const item = (value: string): JsonNode => ({ type: 'listItem', content: [para(value)] });
export const bullets = (items: string[]): JsonNode => ({ type: 'bulletList', content: items.map(item) });
export const ordered = (items: string[], start = 1): JsonNode => ({ type: 'orderedList', attrs: { start }, content: items.map(item) });
export const block = (classes: string[], content: JsonNode[]): JsonNode => ({ type: 'themeBlock', attrs: { classes }, content });
export const page = (content: JsonNode[], attrs: Record<string, unknown>): JsonNode => ({ type: 'page', attrs, content });

/** A table with a header row of `head` cells and `rows` of body cells. */
export function table(head: string[], rows: string[][]): JsonNode {
  const cell = (type: string, value: string): JsonNode => ({ type, content: [para(value)] });
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: head.map((h) => cell('tableHeader', h)) },
      ...rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell('tableCell', c)) })),
    ],
  };
}

export function definitionList(pairs: [string, string][]): JsonNode {
  return {
    type: 'definitionList',
    content: pairs.flatMap(([term, desc]) => [
      { type: 'definitionTerm', content: [text(term, [{ type: 'bold' }])] },
      { type: 'definitionDesc', content: [text(desc)] },
    ]),
  };
}

/** Theme images with their natural size (themes/assets, served at /assets). */
export const IMAGES = [
  { src: '/assets/catwarrior.jpg', width: 600, height: 556 },
  { src: '/assets/bird.webp', width: 748, height: 976 },
  { src: '/assets/frigate.webp', width: 4096, height: 2727 },
  { src: '/assets/ruined_tower.webp', width: 4096, height: 3011 },
  { src: '/assets/roman_theatre.webp', width: 4096, height: 2968 },
  { src: '/assets/the_departure.webp', width: 4096, height: 2540 },
] as const;

/** A paragraph holding one image at the column's width, with its natural width and height. */
export function imageParagraph(index: number, alt: string): JsonNode {
  const img = IMAGES[index % IMAGES.length]!;
  return para([{ type: 'image', attrs: { src: img.src, alt, width: img.width, height: img.height, style: 'width: 100%;' } }]);
}

// Content -----------------------------------------------------------------------------------------

function statBlock(p: Prose): JsonNode {
  const stat = () => String(p.int(6, 20));
  return block(
    ['monster', 'frame'],
    [
      heading(2, p.name()),
      para([text(`Medium ${p.pick(ADJECTIVES)} ${p.pick(NOUNS)}, unaligned`, [{ type: 'italic' }])]),
      para([text('Armor Class ', [{ type: 'bold' }]), text(`${p.int(10, 18)} (natural armor)`)]),
      para([text('Hit Points ', [{ type: 'bold' }]), text(`${p.int(20, 140)} (${p.int(3, 18)}d8 + ${p.int(2, 30)})`)]),
      table(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'], [[stat(), stat(), stat(), stat(), stat(), stat()]]),
      para([text(`${p.title(1)}. `, [{ type: 'bold' }, { type: 'italic' }]), text(p.text(160))]),
      para([text(`${p.title(1)}. `, [{ type: 'bold' }, { type: 'italic' }]), text(p.text(200))]),
      heading(3, 'Actions'),
      para([text('Strike. ', [{ type: 'bold' }, { type: 'italic' }]), text(p.text(180))]),
    ],
  );
}

function randomTable(p: Prose): JsonNode {
  const die = p.pick([4, 6, 8, 10]);
  const rows: string[][] = [];
  for (let i = 1; i <= die; i++) rows.push([String(i), p.text(p.int(30, 90))]);
  return table([`d${die}`, p.title(1)], rows);
}

/** One subsection: a heading and a mix of blocks, about `chars` characters of text. */
function subsection(p: Prose, level: number, chars: number, k: number): JsonNode[] {
  const out: JsonNode[] = [heading(level, p.title(2))];
  let used = 0;
  let n = 0;
  while (used < chars) {
    const r = (k * 7 + n * 3) % 17;
    n += 1;
    if (r === 3) {
      out.push(bullets(Array.from({ length: p.int(3, 7) }, () => p.text(p.int(40, 160)))));
      used += 450;
    } else if (r === 7) {
      out.push(ordered(Array.from({ length: p.int(4, 9) }, () => p.text(p.int(40, 140)))));
      used += 550;
    } else if (r === 11) {
      out.push(block(['note'], [heading(5, p.title(1)), para(p.text(p.int(180, 420)))]));
      used += 400;
    } else if (r === 13) {
      out.push(randomTable(p));
      used += 500;
    } else if (r === 15 && k % 3 === 0) {
      out.push(definitionList(Array.from({ length: p.int(3, 5) }, () => [p.title(1), p.text(p.int(60, 160))] as [string, string])));
      used += 450;
    } else {
      const len = p.int(250, 950);
      out.push(para(p.text(len)));
      used += len;
    }
  }
  return out;
}

/** A 2-column chapter of roughly `pages` 5ePHB pages. */
function chapter(p: Prose, index: number, pages: number): JsonNode {
  const title = `${p.title(2)}`;
  const content: JsonNode[] = [heading(1, `Chapter ${index}: ${title}`), para(p.text(700)), para(p.text(520))];
  content.push(block(['descriptive'], [para(p.text(420))]));
  // ~5,600 characters of body text per page, less the tables, blocks and images below.
  const budget = pages * 5600;
  let used = 1600;
  let k = 0;
  while (used < budget) {
    k += 1;
    if (k % 4 === 1) {
      content.push(...subsection(p, 2, 1800, k + index));
      used += 1800;
    } else {
      content.push(...subsection(p, 3, 2400, k + index));
      used += 2400;
    }
    if (k === 2) {
      content.push(imageParagraph(index + k, `Illustration ${index}`));
      used += 2200;
    }
    if (k === 5) {
      content.push(statBlock(p));
      used += 1800;
    }
    if (k === 7 && index % 2 === 0) {
      content.push(block(['wide'], [para(p.text(520))]));
      used += 700;
    }
    if (k === 9) {
      content.push(imageParagraph(index + k + 1, `Map ${index}`));
      used += 2200;
    }
  }
  return page(content, { pid: `perfch${String(index).padStart(2, '0')}`, columns: 2, pageNumber: true, footer: `Chapter ${index}: ${title}` });
}

/** The ~150-page brew, manual pages only (see the top). `scale` sizes the chapters. */
export function rawBrew150(scale = 1): JsonNode {
  const p = new Prose(20260925);
  const cover = page(
    [heading(1, 'The Atlas of Quiet Roads'), para(p.text(160)), para([text('A generated performance fixture', [{ type: 'italic' }])])],
    {
      pid: 'perfcover',
      columns: 1,
      markers: ['frontCover'],
      objects: [{ id: 'perf-cover-art', kind: 'image', classes: [], style: 'position: absolute; bottom: 0; left: 0; width: 100%;', src: '/assets/the_departure.webp' }],
    },
  );
  const contents = page([{ type: 'toc', attrs: { depth: 1, wide: true, title: 'Contents' } }, para(p.text(300))], { pid: 'perftoc', columns: 2 });
  const chapters: JsonNode[] = [];
  for (let i = 1; i <= 12; i++) chapters.push(chapter(p, i, 8.3 * scale));
  const appendixBody: JsonNode[] = [heading(1, 'Appendix: Tables of the Road')];
  for (let k = 0; k < 6; k++) {
    appendixBody.push(heading(2, p.title(2)), para(p.text(600)), randomTable(p), para(p.text(400)));
  }
  const appendix = page(appendixBody, { pid: 'perfappx', columns: 1, pageNumber: true, footer: 'Appendix' });
  return { type: 'doc', content: [cover, contents, ...chapters, appendix] };
}

/**
 * One 2-column section that paginates to ~50 pages (see the top): flowing prose, the case where
 * an edit on page 1 moves every later boundary (plan §4.10). Long paragraphs (a third of a column
 * to a column and a half), so most pages end inside a paragraph, full to the last line; a heading
 * every nine paragraphs.
 */
export function rawSection50(scale = 1): JsonNode {
  const p = new Prose(50505050);
  const content: JsonNode[] = [heading(1, 'The Long Road North')];
  const budget = 50 * 5600 * scale;
  let used = 0;
  for (let k = 0; used < budget; k++) {
    if (k > 0 && k % 9 === 0) content.push(heading(3, p.title(2)));
    const len = p.int(1200, 4200);
    content.push(para(p.text(len)));
    used += len;
  }
  return { type: 'doc', content: [page(content, { pid: 'perfsect', columns: 2, pageNumber: true, footer: 'The Long Road North' })] };
}

/** Number of characters of text in a JSON document (sizes the fixtures in reports). */
export function textLength(node: JsonNode): number {
  return (node.text?.length ?? 0) + (node.content ?? []).reduce((sum, child) => sum + textLength(child), 0);
}
