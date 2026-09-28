// Source text → document nodes: the import pipeline's last steps (plan §7) on the author's HTML.
//
//   1. the import sanitizer (import/sanitize.ts: DOMPurify with the schema's allow-list), which
//      also reports what it removed. Two things go around it, because the schema stores more than
//      marked-hbfm ever writes:
//        - raw HTML islands (elements the schema keeps whole as rawHtml/rawInline: RAW_HTML_TAGS,
//          div[data-hb-raw] wrappers, divs with attributes): their parse rules sanitize them
//          with the rawHtml policy (schema/html.ts sanitizeRawHtml, the server's policy), e.g.
//          MathML, which the import allow-list has no profile for;
//        - attributes the schema renders that the import allow-list lacks (PROTECTED_ATTRS);
//   2. formatting whitespace dropped: a run of whitespace with a line break in it is layout of
//      the source (indentation), so it goes next to block boundaries and becomes one space
//      elsewhere, as a browser renders it. Whitespace without a line break is kept exactly
//      (preserveWhitespace), so text round-trips; code blocks and raw HTML keep all of theirs;
//   3. the schema's parse rules (ProseMirror's DOMParser), which apply the URL policy and the
//      generic-attribute allow-lists; what has no rule falls back to rawHtml, as on import;
//   4. what the source view leaves out is restored: no `continuation` flags (the source shows
//      whole blocks), a heading with an id has a custom id, sections are manual pages.
//
// The result lists the problems found (the parse report) so the dialog can show them first.
import { DOMParser as PMDOMParser, Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { sanitizeImportHtmlDetailed } from '../import/sanitize';
import { isSafeHref, isSafeSrc, sanitizeRawHtml } from '../schema/html';
import { RAW_HTML_TAGS } from '../schema/nodes/blocks';

export type SourceProblemKind = 'removed' | 'rawHtml' | 'unwrapped' | 'outsidePage' | 'sectionBreak';

export interface SourceProblem {
  kind: SourceProblemKind;
  /** What happened, in a sentence. */
  message: string;
  /** How often (removals of one tag or attribute are counted together). */
  count: number;
}

export interface ParsedSection {
  /** The section's first page: its attributes from the source (content: the flow, as parsed). */
  page: PMNode;
  blocks: PMNode[];
}

export interface ParsedBlocks {
  mode: 'blocks';
  blocks: PMNode[];
  problems: SourceProblem[];
}

export interface ParsedSections {
  mode: 'sections';
  sections: ParsedSection[];
  problems: SourceProblem[];
}

/** Elements with block-level layout: formatting whitespace next to them is dropped. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'col', 'colgroup', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** Divs the schema has rules for (any other div with attributes is kept whole as rawHtml). */
const SCHEMA_DIV_CLASSES = ['page', 'columnWrapper', 'block', 'columnSplit', 'blank'];
/** Clipboard metadata: never a reason to keep a div whole (schema/nodes/blocks.ts). */
const IGNORED_DIV_ATTRS = new Set(['data-pm-slice', 'data-hb-clipboard']);
/** Inline tags without a rule: the parser keeps their text and drops the tag and attributes. */
const TRANSPARENT_TAGS = new Set([
  'font', 'small', 'big', 'mark', 'ins', 'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'time', 'dfn', 'tt', 'bdi', 'bdo', 'ruby', 'rt',
  'rp', 'label', 'nobr', 'caption',
]);
/** Attributes the schema renders that the import sanitizer doesn't allow, by tag. */
const PROTECTED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  a: ['target', 'rel'],
  td: ['colwidth'],
  th: ['colwidth'],
};
const PROTECTED_PREFIX = 'data-hb-keep-';
const ISLAND_ATTR = 'data-hb-island';

/** Whether the schema keeps `el` whole as raw HTML (its parse rules sanitize it themselves). */
function isRawIsland(el: Element): boolean {
  const tag = el.localName;
  if ((RAW_HTML_TAGS as readonly string[]).includes(tag) || el.hasAttribute('data-hb-raw')) return true;
  if (tag !== 'div' || SCHEMA_DIV_CLASSES.some((c) => el.classList.contains(c))) return false;
  return Array.from(el.attributes).some((a) => !IGNORED_DIV_ATTRS.has(a.name));
}

/** Whether the whitespace inside `el` belongs to its content (code, raw HTML). */
const keepsWhitespace = (el: Element): boolean => el.localName === 'pre' || el.localName === 'textarea' || isRawIsland(el);

const isBlockElement = (node: ChildNode | null): boolean => node !== null && node.nodeType === 1 && BLOCK_TAGS.has((node as Element).localName);

/** Whether the side of a text node (its sibling, or its parent's edge) is a block boundary. */
function atBoundary(sibling: ChildNode | null, parent: ParentNode): boolean {
  if (sibling) return isBlockElement(sibling);
  return parent.nodeType !== 1 || BLOCK_TAGS.has((parent as Element).localName) || (parent as Element).localName === 'body';
}

const FORMATTING = /[ \t\f]*[\r\n][ \t\r\n\f]*/g;
const LEADING = /^[ \t\r\n\f]*[\r\n][ \t\r\n\f]*/;
const TRAILING = /[ \t\r\n\f]*[\r\n][ \t\r\n\f]*$/;

/** Drops or collapses formatting whitespace (runs with a line break) under `root`. */
export function normalizeSourceWhitespace(root: ParentNode): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 1) {
      if (!keepsWhitespace(child as Element)) normalizeSourceWhitespace(child as Element);
      continue;
    }
    if (child.nodeType !== 3) continue;
    const text = child as Text;
    if (!/[\r\n]/.test(text.data)) continue;
    const before = atBoundary(text.previousSibling, root);
    const after = atBoundary(text.nextSibling, root);
    if (/^[ \t\r\n\f]*$/.test(text.data)) {
      if (before || after) text.remove();
      else text.data = ' ';
      continue;
    }
    text.data = text.data
      .replace(LEADING, before ? '' : ' ')
      .replace(TRAILING, after ? '' : ' ')
      .replace(FORMATTING, ' ');
  }
}

const bump = (problems: Map<string, SourceProblem>, key: string, kind: SourceProblemKind, message: string, count = 1) => {
  const found = problems.get(key);
  if (found) found.count += count;
  else problems.set(key, { kind, message, count });
};

/** Replaces the outermost raw islands under `root` with placeholders; returns them by index. */
function liftIslands(root: Element): Element[] {
  const islands: Element[] = [];
  const walk = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (child.localName === 'pre') continue;
      if (isRawIsland(child)) {
        const placeholder = root.ownerDocument.createElement('span');
        placeholder.setAttribute(ISLAND_ATTR, String(islands.length));
        islands.push(child);
        child.replaceWith(placeholder);
      } else walk(child);
    }
  };
  walk(root);
  return islands;
}

/** Puts the islands back where their placeholders are; reports markup their sanitizer removes. */
function restoreIslands(root: Element, islands: readonly Element[], problems: Map<string, SourceProblem>): void {
  for (const placeholder of Array.from(root.querySelectorAll(`span[${ISLAND_ATTR}]`))) {
    const island = islands[Number(placeholder.getAttribute(ISLAND_ATTR))];
    if (!island) {
      placeholder.remove();
      continue;
    }
    placeholder.replaceWith(island);
    const html = island.hasAttribute('data-hb-raw') ? island.innerHTML : island.outerHTML;
    if (sanitizeRawHtml(html) !== html.trim()) {
      bump(problems, 'removed:raw', 'removed', 'Raw HTML contained markup that is not allowed (scripts, event handlers, forms, …); it was removed.');
    }
  }
}

function protectAttributes(root: Element, restore: boolean): void {
  for (const [tag, names] of Object.entries(PROTECTED_ATTRS)) {
    for (const name of names) {
      const from = restore ? PROTECTED_PREFIX + name : name;
      const to = restore ? name : PROTECTED_PREFIX + name;
      for (const el of Array.from(root.querySelectorAll(`${tag}[${from}]`))) {
        el.setAttribute(to, el.getAttribute(from)!);
        el.removeAttribute(from);
      }
    }
  }
}

/** Elements and attributes the schema can't keep, found before parsing. */
function inspectMarkup(root: Element, problems: Map<string, SourceProblem>, mode: 'blocks' | 'sections'): void {
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      if (isRawIsland(el)) continue;
      const tag = el.localName;
      if (TRANSPARENT_TAGS.has(tag)) {
        bump(problems, `unwrapped:${tag}`, 'unwrapped', `<${tag}> has no equivalent: its text is kept, the tag and its attributes are dropped.`);
      } else if (tag === 'span' && !el.classList.contains('inline-block') && el.attributes.length > 0) {
        bump(problems, 'unwrapped:span', 'unwrapped', '<span> without the inline-block class: its text is kept, its attributes are dropped (write class="inline-block …").');
      } else if (tag === 'a' && el.hasAttribute('href') && !isSafeHref(el.getAttribute('href')!)) {
        bump(problems, 'removed:href', 'removed', 'A link to an address that is not allowed (only http, https, mailto and relative links) lost its link.');
      } else if (tag === 'img' && !isSafeSrc(el.getAttribute('src') ?? '')) {
        bump(problems, 'removed:src', 'removed', 'An image without an allowed source (http, https, relative or data:image) was removed.');
      } else if (tag === 'div' && el.classList.contains('page') && mode === 'blocks') {
        bump(problems, 'sectionBreak', 'sectionBreak', 'A <div class="page"> (a new section) can only be added when editing a section or the whole brew; its content was kept.');
      }
      walk(el);
    }
  };
  walk(root);
  if (mode === 'sections') {
    const outside = Array.from(root.childNodes).some((child) =>
      child.nodeType === 1 ? !(child as Element).matches('div.page') : child.nodeType === 3 && (child.textContent ?? '').trim() !== '',
    );
    if (outside) bump(problems, 'outsidePage', 'outsidePage', 'Content outside a <div class="page"> was put in a section of its own.');
  }
}

/** Raw HTML (rawHtml, rawInline) in `nodes`, as html strings. */
export function rawHtmlOf(nodes: Iterable<PMNode>): string[] {
  const found: string[] = [];
  const visit = (node: PMNode) => {
    if (node.type.name === 'rawHtml' || node.type.name === 'rawInline') found.push(String(node.attrs.html));
    else node.forEach(visit);
  };
  for (const node of nodes) visit(node);
  return found;
}

/** Problems for raw HTML in the result that the replaced content didn't have. */
function rawHtmlProblems(parsed: readonly PMNode[], before: readonly string[], problems: Map<string, SourceProblem>): void {
  const known = new Map<string, number>();
  for (const html of before) known.set(html, (known.get(html) ?? 0) + 1);
  for (const html of rawHtmlOf(parsed)) {
    const left = known.get(html) ?? 0;
    if (left > 0) {
      known.set(html, left - 1);
      continue;
    }
    const tag = /^<([a-zA-Z][\w-]*)/.exec(html)?.[1]?.toLowerCase() ?? '';
    const label = tag ? `<${tag}>` : 'Markup';
    bump(problems, `rawHtml:${tag}`, 'rawHtml', `${label} has no block equivalent and is kept as raw HTML (a code box in the editor).`);
  }
}

/**
 * What the source leaves out, restored on a parsed block: no `continuation` flags (the source
 * shows whole blocks), and a heading's id is a custom id exactly when it has one.
 */
function restoreNoise(node: PMNode): PMNode {
  if (node.isText) return node;
  let content = node.content;
  if (!node.isLeaf) {
    let changed = false;
    const children: PMNode[] = [];
    node.forEach((child) => {
      const next = restoreNoise(child);
      if (next !== child) changed = true;
      children.push(next);
    });
    if (changed) content = Fragment.fromArray(children);
  }
  let attrs = node.attrs;
  if (attrs.continuation === true) attrs = { ...attrs, continuation: false };
  if (node.type.name === 'heading') {
    const id = typeof attrs.id === 'string' && attrs.id !== '' ? attrs.id : null;
    if (attrs.id !== id || attrs.customId !== (id !== null)) attrs = { ...attrs, id, customId: id !== null };
  }
  if (content === node.content && attrs === node.attrs) return node;
  return node.type.create(attrs, content, node.marks);
}

interface Prepared {
  body: HTMLElement;
  problems: Map<string, SourceProblem>;
}

function prepare(text: string, mode: 'blocks' | 'sections'): Prepared {
  const problems = new Map<string, SourceProblem>();
  // An inert document: nothing in it loads (images, fonts) while the source is parsed.
  const doc = document.implementation.createHTMLDocument('');
  const raw = doc.createElement('body');
  raw.innerHTML = text.trim();
  const islands = liftIslands(raw);
  protectAttributes(raw, false);
  const { html, removed } = sanitizeImportHtmlDetailed(raw.innerHTML);
  for (const [tag, count] of Object.entries(removed.elements)) {
    const message = tag === '#comment' ? 'HTML comments are not kept.' : `<${tag}> is not allowed and was removed.`;
    bump(problems, `sanitizer:${tag}`, 'removed', message, count);
  }
  for (const [name, count] of Object.entries(removed.attributes)) {
    bump(problems, `sanitizer@${name}`, 'removed', `The attribute ${name} is not allowed and was removed.`, count);
  }
  const body = doc.body;
  body.innerHTML = html;
  protectAttributes(body, true);
  restoreIslands(body, islands, problems);
  inspectMarkup(body, problems, mode);
  normalizeSourceWhitespace(body);
  return { body, problems };
}

/**
 * Parses the source of a run of blocks (the selection scope). `before`: the raw HTML the replaced
 * blocks held (only new raw HTML is reported). Whitespace-only source is no blocks.
 */
export function parseBlocksSource(schema: Schema, text: string, before: readonly string[] = []): ParsedBlocks {
  if (text.trim() === '') return { mode: 'blocks', blocks: [], problems: [] };
  const { body, problems } = prepare(text, 'blocks');
  const page = PMDOMParser.fromSchema(schema).parse(body, { preserveWhitespace: true, topNode: schema.nodes.page!.create() });
  const blocks: PMNode[] = [];
  page.forEach((block) => blocks.push(restoreNoise(block)));
  rawHtmlProblems(blocks, before, problems);
  return { mode: 'blocks', blocks, problems: [...problems.values()] };
}

/**
 * Parses the source of sections (the section and whole-brew scopes): each div.page is a section,
 * a manual page with the attributes written on it. Whitespace-only source is no sections.
 */
export function parseSectionsSource(schema: Schema, text: string, before: readonly string[] = []): ParsedSections {
  if (text.trim() === '') return { mode: 'sections', sections: [], problems: [] };
  const { body, problems } = prepare(text, 'sections');
  const doc = PMDOMParser.fromSchema(schema).parse(body, { preserveWhitespace: true });
  const sections: ParsedSection[] = [];
  doc.forEach((page) => {
    const blocks: PMNode[] = [];
    page.forEach((block) => blocks.push(restoreNoise(block)));
    sections.push({ page: page.type.create({ ...page.attrs, kind: 'manual', pid: null, oversized: false }, Fragment.fromArray(blocks)), blocks });
  });
  rawHtmlProblems(
    sections.flatMap((s) => s.blocks),
    before,
    problems,
  );
  return { mode: 'sections', sections, problems: [...problems.values()] };
}
