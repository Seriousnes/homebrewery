// Heading id slugs, compatible with upstream (marked-gfm-heading-id 4 + github-slugger 2, which
// marked-hbfm configures with globalSlugs, so ids are unique across the whole brew).
//
// github-slugger lowercases, removes every character that is not alphabetic, a combining mark,
// a decimal digit, connector punctuation (_), a space or a hyphen, then turns spaces into
// hyphens. Its generated regex equals the Unicode-property class below for every code point
// assigned in its Unicode version (checked exhaustively over U+0000–U+10FFFF); code points
// assigned later are kept here but removed upstream.
import type { Node as PMNode } from '@tiptap/pm/model';

const SLUG_REMOVE = /[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc} -]/gu;

/** github-slugger's `slug()` (without uniqueness). */
export function slugify(value: string): string {
  return value.toLowerCase().replace(SLUG_REMOVE, '').replace(/ /g, '-');
}

/** Unique slugs in document order, like github-slugger's `GithubSlugger#slug`. */
export class HeadingSlugger {
  private readonly occurrences = new Map<string, number>();

  /** Marks an id as taken (custom heading ids) so generated slugs avoid it. */
  reserve(id: string): void {
    if (!this.occurrences.has(id)) this.occurrences.set(id, 0);
  }

  /** The next unique slug for `value`, or null when the slug is empty. */
  slug(value: string): string | null {
    const original = slugify(value);
    if (original === '') return null;
    let result = original;
    while (this.occurrences.has(result)) {
      const n = (this.occurrences.get(original) ?? 0) + 1;
      this.occurrences.set(original, n);
      result = `${original}-${n}`;
    }
    this.occurrences.set(result, 0);
    return result;
  }
}

// Upstream slugs the heading's rendered HTML: entities are unescaped, the string is trimmed,
// and only then are tags removed. Inline atoms (icons, images, spacers, line breaks) therefore
// keep neighbouring whitespace from being trimmed. A placeholder character reproduces that.
const ATOM = '\u0000';
// eslint-disable-next-line no-control-regex -- the placeholder is a control character on purpose
const ATOMS = /\u0000/g;

/** The text upstream would slug for a heading node. */
export function headingSlugSource(heading: PMNode): string {
  let text = '';
  heading.forEach((child) => {
    text += child.isText ? (child.text ?? '') : ATOM;
  });
  return text.trim().replace(ATOMS, '');
}

const UNESCAPE = /&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/gi;

/** The text upstream would slug for a heading element (marked-gfm-heading-id's algorithm). */
export function headingSlugSourceFromHtml(innerHtml: string): string {
  return innerHtml
    .replace(UNESCAPE, (_m, n: string) => {
      const name = n.toLowerCase();
      if (name === 'colon') return ':';
      if (name.startsWith('#x')) return String.fromCharCode(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCharCode(Number(name.slice(1)));
      return '';
    })
    .trim()
    .replace(/<[!/a-z].*?>/gi, '');
}

const HEADING_TAGS = 'h1, h2, h3, h4, h5, h6';

interface ParsedHeadings {
  /** The id the slugger gives each heading element at its place in document order. */
  ids: Map<Element, string | null>;
  /** The HTML is this editor's clipboard (ProseMirror's data-pm-slice). */
  clipboard: boolean;
}
const parsedHeadings = new WeakMap<Node, ParsedHeadings>();

function headingsOf(el: Element): ParsedHeadings {
  let root: Node = el;
  while (root.parentNode) root = root.parentNode;
  let parsed = parsedHeadings.get(root);
  if (!parsed?.ids.has(el)) {
    const all = Array.from((root as ParentNode).querySelectorAll(HEADING_TAGS));
    const slugger = new HeadingSlugger();
    // Ids this editor marked as the author's (its own HTML) are taken first, as HeadingIds does.
    for (const h of all) if (h.hasAttribute('data-custom-id') && h.id) slugger.reserve(h.id);
    const ids = new Map<Element, string | null>();
    for (const h of all) ids.set(h, h.hasAttribute('data-custom-id') ? h.id : slugger.slug(headingSlugSourceFromHtml(h.innerHTML)));
    parsed = { ids, clipboard: (root as ParentNode).querySelector('[data-pm-slice]') !== null };
    parsedHeadings.set(root, parsed);
  }
  return parsed;
}

/**
 * Whether a parsed heading's `id` was generated rather than chosen by the author. HTML from this
 * editor's clipboard marks the author's ids (data-custom-id), so its other ids are slugs, numbered
 * across the document they were copied from: the slug or slug-<n>. In other HTML (imported brews,
 * exports) an id is generated only if it is exactly what upstream's slugger gives the heading at
 * its place in document order: an author's `{#intro-2}` on a lone "Intro" stays custom.
 */
export function isGeneratedHeadingId(el: Element, id: string): boolean {
  const parsed = headingsOf(el);
  if (parsed.clipboard) return isGeneratedSlug(id, headingSlugSourceFromHtml(el.innerHTML));
  return parsed.ids.get(el) === id;
}

/** Whether `id` looks generated for `source`: the slug itself or the slug plus `-<n>`. */
export function isGeneratedSlug(id: string, source: string): boolean {
  const base = slugify(source);
  if (id === base) return true;
  return id.startsWith(`${base}-`) && /^\d+$/.test(id.slice(base.length + 1));
}
