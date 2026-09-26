// Cleanup of HTML pasted from other applications (Word, Google Docs, web pages): S1, P3.4.
//
// This editor's own clipboard HTML (copy/paste inside the editor, or between two editor tabs) is
// passed through untouched: its classes and styles are the author's (note, monster, wide …). It
// is recognised by CLIPBOARD_ATTR, which the clipboard serializer below puts on the element that
// gets ProseMirror's data-pm-slice; data-pm-slice alone also comes from every other
// ProseMirror-based app. Everything else is external and is reduced to semantics before the
// schema's parse rules see it:
//
// - Formatting written as inline styles (Google Docs: span[style=font-weight:700]) becomes
//   elements: strong, em, u, s, sup, sub. text-align on paragraphs becomes align.
// - Word list paragraphs (p[style*=mso-list] with a marker span) become ul/ol › li, nested by
//   level; Google Docs' misplaced nested lists (ul › ul) move into the previous li.
// - Every attribute is dropped except href (a), src/alt/title/width/height (img),
//   colspan/rowspan (td, th), start/type (ol) and align (p). No class, style, id, dir, lang,
//   role, aria-* or data-* survive, so nothing becomes a theme class, a generic attribute or a
//   rawHtml block by accident (a div with any attribute is rawHtml in the schema).
// - Wrappers are unwrapped: Google's b#docs-internal-guid-…, Word's div.WordSection1, office
//   namespace tags (o:p), font, span, and sectioning elements the schema would keep as rawHtml
//   (section, article, header, figure …).
// - Comments, <style>, <meta>, <link>, <script>, <xml>, <title> and embedded content (svg,
//   math, video, audio, canvas, map, object, iframe) are removed.
import { Extension } from '@tiptap/core';
import { DOMSerializer, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/** Marks HTML copied from this editor (schema RESERVED_ATTRS keeps it out of documents). */
export const CLIPBOARD_ATTR = 'data-hb-clipboard';
const CLIPBOARD_VALUE = '1';

/**
 * Whether `html` was copied from this editor: the element with ProseMirror's data-pm-slice (or,
 * for table parts, the element inside the `-N` wrappers ProseMirror added around them) carries
 * CLIPBOARD_ATTR. The HTML is parsed; its text is never searched.
 */
export function isEditorClipboardHtml(html: string, parser: DOMParser = new DOMParser()): boolean {
  const slice = parser.parseFromString(html, 'text/html').body.querySelector('[data-pm-slice]');
  if (!slice) return false;
  const wrappers = /^\d+ \d+ -(\d+)/.exec(slice.getAttribute('data-pm-slice') ?? '');
  let el: Element | null = slice;
  for (let i = Number(wrappers?.[1] ?? 0); i > 0 && el; i--) el = el.firstElementChild;
  return el?.getAttribute(CLIPBOARD_ATTR) === CLIPBOARD_VALUE;
}

/**
 * The schema's serializer, with CLIPBOARD_ATTR on the top-level elements of what it serializes
 * (ProseMirror then puts data-pm-slice on the first of them, or on wrappers around it).
 */
function clipboardSerializer(schema: Schema): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema);
  const serializer = new DOMSerializer(base.nodes, base.marks);
  const serializeFragment = serializer.serializeFragment.bind(serializer);
  serializer.serializeFragment = (fragment, options, target) => {
    const dom = serializeFragment(fragment, options, target);
    for (const child of Array.from(dom.childNodes)) {
      if (child.nodeType === 1) (child as Element).setAttribute(CLIPBOARD_ATTR, CLIPBOARD_VALUE);
    }
    return dom;
  };
  return serializer;
}

// Embedded content goes too: inline SVG icons, formulas and media from web pages would keep no
// attribute below (an empty 300×150 box) and aren't document content.
const REMOVE = new Set([
  'style',
  'meta',
  'link',
  'script',
  'title',
  'xml',
  'head',
  'noscript',
  'template',
  'object',
  'embed',
  'iframe',
  'svg',
  'math',
  'video',
  'audio',
  'canvas',
  'map',
]);
const UNWRAP = new Set([
  'font',
  'span',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'nav',
  'main',
  'center',
  'address',
  'hgroup',
  'figure',
  'picture',
  'big',
  'small',
  'mark',
  'ins',
  'abbr',
  'cite',
  'dfn',
  'kbd',
  'samp',
  'var',
  'bdi',
  'bdo',
  'time',
  'label',
]);
const KEEP_ATTRS: Record<string, readonly string[]> = {
  a: ['href'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start', 'type'],
  p: ['align'],
};
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'blockquote', 'pre', 'dl', 'div', 'hr']);
const ALIGNS = new Set(['left', 'center', 'right', 'justify']);

type StyleFlags = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; sup?: boolean; sub?: boolean };

function styleFlags(el: HTMLElement): StyleFlags {
  const s = el.style;
  const flags: StyleFlags = {};
  const weight = s.fontWeight.trim().toLowerCase();
  if (weight === 'bold' || weight === 'bolder' || (/^\d+$/.test(weight) && Number(weight) >= 600)) flags.bold = true;
  if (s.fontStyle.trim().toLowerCase() === 'italic' || s.fontStyle.trim().toLowerCase() === 'oblique') flags.italic = true;
  const decoration = `${s.textDecoration} ${s.textDecorationLine || ''} ${el.getAttribute('style') ?? ''}`.toLowerCase();
  // The raw style is checked too: jsdom and older engines don't expand the shorthand.
  if (
    /text-decoration(?:-line)?\s*:[^;]*underline/.test(decoration) ||
    /\bunderline\b/.test(`${s.textDecoration} ${s.textDecorationLine || ''}`)
  )
    flags.underline = true;
  if (
    /text-decoration(?:-line)?\s*:[^;]*line-through/.test(decoration) ||
    /\bline-through\b/.test(`${s.textDecoration} ${s.textDecorationLine || ''}`)
  )
    flags.strike = true;
  const valign = s.verticalAlign.trim().toLowerCase();
  if (valign === 'super') flags.sup = true;
  if (valign === 'sub') flags.sub = true;
  return flags;
}

const ALREADY: Record<keyof StyleFlags, string[]> = {
  bold: ['b', 'strong'],
  italic: ['i', 'em'],
  underline: ['u'],
  strike: ['s', 'strike', 'del'],
  sup: ['sup'],
  sub: ['sub'],
};
const WRAP_TAG: Record<keyof StyleFlags, string> = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', sup: 'sup', sub: 'sub' };

/** Wraps the element's children in the elements its inline style stands for. */
function styleToElements(el: HTMLElement): void {
  if (!el.hasAttribute('style')) return;
  const flags = styleFlags(el);
  const tag = el.localName;
  const insideLink = el.closest('a') !== null;
  const isBlock = BLOCK_TAGS.has(tag) || tag === 'td' || tag === 'th';
  for (const key of Object.keys(flags) as (keyof StyleFlags)[]) {
    if (!flags[key] || ALREADY[key].includes(tag)) continue;
    if (key === 'underline' && insideLink) continue; // links are underlined by their style
    if (key === 'bold' && /^h[1-6]$/.test(tag)) continue; // headings are bold already
    if (isBlock && el.childNodes.length === 0) continue;
    const wrapper = el.ownerDocument.createElement(WRAP_TAG[key]);
    // Blocks keep their children structure: wrap only when all children are inline.
    if (isBlock && Array.from(el.children).some((c) => BLOCK_TAGS.has(c.localName))) continue;
    wrapper.append(...Array.from(el.childNodes));
    el.append(wrapper);
  }
  if (tag === 'p' && !el.hasAttribute('align')) {
    const align = el.style.textAlign.trim().toLowerCase();
    if (ALIGNS.has(align) && align !== 'left') el.setAttribute('align', align);
  }
}

function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

// --- Word lists ---------------------------------------------------------------------------------

interface WordListItem {
  el: HTMLElement;
  level: number;
  ordered: boolean;
  start: number | null;
}

const ORDERED_MARKER = /^\(?(?:\d+|[a-z]|[ivxlcdm]+)[.)]$/i;

function wordListItem(el: Element): WordListItem | null {
  if (el.localName !== 'p' && !/^h[1-6]$/.test(el.localName)) return null;
  const style = el.getAttribute('style') ?? '';
  const m = /mso-list\s*:\s*(?:l\d+\s+)?level(\d+)/i.exec(style);
  if (!m) return null;
  const html = el as HTMLElement;
  const markerEl = Array.from(html.querySelectorAll<HTMLElement>('span')).find((s) =>
    /mso-list\s*:\s*ignore/i.test(s.getAttribute('style') ?? ''),
  );
  const marker = (markerEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
  // The marker span sits inside other spans that only exist for it: remove the outermost one
  // that holds nothing else.
  if (markerEl) {
    let outer: HTMLElement = markerEl;
    while (outer.parentElement && outer.parentElement !== html && outer.parentElement.textContent === outer.textContent)
      outer = outer.parentElement;
    outer.remove();
  }
  const ordered = ORDERED_MARKER.test(marker);
  const start = ordered && /^\(?\d+/.test(marker) ? parseInt(marker.replace(/^\(/, ''), 10) : null;
  return { el: html, level: Math.max(1, parseInt(m[1]!, 10)), ordered, start };
}

/** Turns runs of Word list paragraphs into nested ul/ol › li › p. */
function convertWordLists(root: Element): void {
  const doc = root.ownerDocument;
  const paragraphs = Array.from(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6')).filter((p) =>
    /mso-list\s*:/i.test(p.getAttribute('style') ?? ''),
  );
  const done = new Set<Element>();
  for (const first of paragraphs) {
    if (done.has(first)) continue;
    // Collect the run of list paragraphs that are siblings (whitespace between them is fine).
    const run: WordListItem[] = [];
    for (let node: ChildNode | null = first; node; node = node.nextSibling) {
      if (node.nodeType === 3 && !node.textContent?.trim()) continue;
      if (node.nodeType === 8) continue; // comments (<![if !supportLists]>)
      if (node.nodeType !== 1) break;
      const item = wordListItem(node as Element);
      if (!item) break;
      run.push(item);
      done.add(node as Element);
    }
    if (run.length === 0) continue;

    // Lists open and close with the level; a top-level list goes where the run started.
    const stack: { level: number; list: HTMLElement; ordered: boolean }[] = [];
    const anchor = doc.createElement('div');
    run[0]!.el.before(anchor);
    for (const item of run) {
      while (stack.length && stack[stack.length - 1]!.level > item.level) stack.pop();
      let top = stack[stack.length - 1];
      if (top && top.level === item.level && top.ordered !== item.ordered) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (!top || top.level < item.level) {
        const list = doc.createElement(item.ordered ? 'ol' : 'ul');
        if (item.ordered && item.start !== null && item.start !== 1) list.setAttribute('start', String(item.start));
        const parentLi = top?.list.lastElementChild;
        if (parentLi) parentLi.append(list);
        else anchor.before(list);
        top = { level: item.level, list, ordered: item.ordered };
        stack.push(top);
      }
      const li = doc.createElement('li');
      const p = doc.createElement('p');
      p.append(...Array.from(item.el.childNodes));
      li.append(p);
      top.list.append(li);
      item.el.remove();
    }
    anchor.remove();
  }
}

// --- Main ---------------------------------------------------------------------------------------

/** Moves ul/ol that sit directly in a ul/ol (Google Docs nesting) into the previous li. */
function fixNestedLists(root: Element): void {
  for (const list of Array.from(root.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol'))) {
    const prev = list.previousElementSibling;
    if (prev?.localName === 'li') prev.append(list);
    else {
      const li = list.ownerDocument.createElement('li');
      list.before(li);
      li.append(list);
    }
  }
}

function removeComments(root: Node): void {
  const walker = root.ownerDocument!.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode?.removeChild(c);
}

/**
 * Reduces external clipboard HTML to semantic HTML the schema parses into clean nodes (see the
 * file header). Returns body HTML.
 */
export function cleanExternalHtml(html: string, parser: DOMParser = new DOMParser()): string {
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;
  removeComments(body);
  for (const el of Array.from(body.querySelectorAll('*'))) {
    if (REMOVE.has(el.localName)) el.remove();
  }

  // Word: title/subtitle paragraphs are headings; lists are paragraphs.
  for (const p of Array.from(body.querySelectorAll('p.MsoTitle'))) {
    const h = doc.createElement('h1');
    h.append(...Array.from(p.childNodes));
    p.replaceWith(h);
  }
  for (const p of Array.from(body.querySelectorAll('p.MsoSubtitle'))) {
    const h = doc.createElement('h2');
    h.append(...Array.from(p.childNodes));
    p.replaceWith(h);
  }
  convertWordLists(body);
  fixNestedLists(body);

  // Google Docs wraps everything in <b style="font-weight:normal" id="docs-internal-guid-…">.
  for (const el of Array.from(body.querySelectorAll('[id^="docs-internal-guid"]'))) unwrap(el);
  for (const el of Array.from(body.querySelectorAll('b, strong'))) {
    const w = (el as HTMLElement).style.fontWeight.trim();
    if (w === 'normal' || w === '400') unwrap(el);
  }

  // Inline styles → elements (deepest first, so wrappers nest predictably).
  const styled = Array.from(body.querySelectorAll<HTMLElement>('[style]')).reverse();
  for (const el of styled) styleToElements(el);

  // Attributes and wrappers.
  for (const el of Array.from(body.querySelectorAll('*')).reverse()) {
    const tag = el.localName;
    if (tag.includes(':') || UNWRAP.has(tag)) {
      unwrap(el);
      continue;
    }
    const keep = KEEP_ATTRS[tag] ?? [];
    for (const attr of Array.from(el.attributes)) if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
    if (tag === 'a' && !el.hasAttribute('href')) unwrap(el);
    else if (tag === 'p' && el.getAttribute('align')?.toLowerCase() === 'left') el.removeAttribute('align');
  }

  // Google Docs marks blank lines between blocks with a bare <br>: keep them as empty paragraphs.
  for (const br of Array.from(body.querySelectorAll(':scope > br'))) br.replaceWith(doc.createElement('p'));
  return body.innerHTML.trim();
}

export const externalPasteKey = new PluginKey('hbExternalPaste');

/** transformPastedHTML: external HTML is cleaned, the editor's own clipboard is left alone. */
export function transformPastedHtml(html: string): string {
  if (isEditorClipboardHtml(html)) return html;
  try {
    return cleanExternalHtml(html);
  } catch {
    return html;
  }
}

/**
 * Cleans HTML pasted from Word, Google Docs and web pages, and marks what is copied from this
 * editor so its paste is left alone (see the file header).
 */
export const ExternalPaste = Extension.create({
  name: 'hbExternalPaste',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: externalPasteKey,
        props: { transformPastedHTML: transformPastedHtml, clipboardSerializer: clipboardSerializer(this.editor.schema) },
      }),
    ];
  },
});
