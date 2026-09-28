// The brew's pages as static HTML with the editor's DOM (P6.4, plan §3.2 CSS contract, §5).
//
// The export serializes the document with ProseMirror's DOMSerializer (the schema's renderHTML),
// then gives it exactly the DOM a read-only editor shows, so theme CSS, canvas.css and the brew's
// CSS lay it out the same way:
//
//   div.pages.ProseMirror[contenteditable=false]      the editor root (read-only view)
//     div.page#p{n}                                   PageView: renderHTML + chrome marked
//       span.inline-block.<marker> … objects, footer, page number  (contenteditable=false)
//       div.columnWrapper › the flow
//
// What the editor adds on top of renderHTML, reproduced here:
// - NodeViews: PageView (chrome contenteditable=false), ImageView (data-hb-natural and the
//   natural-width variable), TocView (the entries, contenteditable=false). HbTableView and
//   ThemeBlockNodeView render renderHTML's DOM as it is.
// - ProseMirror: every leaf node's element is contenteditable=false (TipTap's CSS then makes it
//   white-space: normal), and a textblock that ends in anything but text (or is empty) gets a
//   trailing <br class="ProseMirror-trailingBreak">, which gives an empty paragraph its line.
//   In Chromium and Safari a textblock ending in such a contenteditable=false node also gets a
//   zero-size <img class="ProseMirror-separator"> after it (canvas.css hides the one after a
//   floated image); the export writes that form (`separators: false` leaves it out, as Firefox).
// - Editor-only DOM: the page ids p{n} (PageIndexIds). The header-row decoration (hb-header-row)
//   becomes a real <thead> instead: the leading all-header rows of a table move into it.
//
// Left out: editor-only state (the oversized badge, data-hb-chrome, data-object-id, draggable),
// the bulky data-objects copy of the page objects, and loading=lazy (printing the file must not
// wait for images to scroll into view).
import { DOMSerializer, type DOMOutputSpec, type Node as PMNode } from '@tiptap/pm/model';
import { CHROME_ATTR, OBJECT_ID_ATTR, OVERSIZED_BADGE_CLASS, OVERSIZED_CLASS, PageView } from '../nodeviews/PageView';
import { TOC_ENTRIES_ATTR } from '../nodeviews/TocView';
import { ImageView } from '../objects/imageView';
import { pageDomId } from '../schema/plugins';
import { headerRowCount } from '../tables/headerRows';
import { collectHeadings, tocClass, tocEntries, tocInnerHtml, type TocHeading } from '../toc';

/** Class of the trailing break ProseMirror adds to textblocks (canvas.css relies on it). */
export const TRAILING_BREAK_CLASS = 'ProseMirror-trailingBreak';
/** Class of ProseMirror's separator image (Chromium, Safari; see the file header). */
export const SEPARATOR_CLASS = 'ProseMirror-separator';

export interface SerializeBrewOptions {
  document?: Document;
  /** Add ProseMirror's separator images, as Chromium and Safari show them (default true). */
  separators?: boolean;
}

export interface SerializedBrew {
  /** div.pages.ProseMirror[contenteditable=false], holding one div.page per page. */
  pages: HTMLElement;
  /** The element of every heading, parallel to collectHeadings(doc). */
  headings: HTMLElement[];
  /** The toc elements and their nodes (fill them with fillTocs). */
  tocs: { el: HTMLElement; node: PMNode }[];
}

interface Rendered {
  dom: Node;
  contentDOM?: HTMLElement;
}

const isElement = (node: Node | null | undefined): node is HTMLElement => node?.nodeType === 1;

function withoutAttributes(el: Element, names: readonly string[]): void {
  for (const name of names) el.removeAttribute(name);
}

/** PageView's DOM for `page`, without the editor-only parts. */
function renderPage(page: PMNode): Rendered {
  const clean = page.attrs.oversized === true ? page.type.create({ ...page.attrs, oversized: false }, page.content, page.marks) : page;
  const view = new PageView(clean);
  const dom = view.dom;
  dom.classList.remove(OVERSIZED_CLASS);
  dom.querySelector(`:scope > .${OVERSIZED_BADGE_CLASS}`)?.remove();
  dom.removeAttribute('data-objects');
  for (const child of Array.from(dom.children)) {
    if (child === view.contentDOM) continue;
    withoutAttributes(child, [CHROME_ATTR, OBJECT_ID_ATTR, 'draggable', 'loading']);
  }
  return { dom, contentDOM: view.contentDOM };
}

/** TocView's element (entries are filled later, see fillTocs). */
function renderToc(node: PMNode, doc: Document): HTMLElement {
  const el = doc.createElement('div');
  el.setAttribute('contenteditable', 'false');
  for (const cls of tocClass(Boolean(node.attrs.wide)).split(' ')) el.classList.add(cls);
  el.setAttribute('data-depth', String(Number(node.attrs.depth) || 3));
  return el;
}

/** Moves the leading header rows of `table` (a <table> element) into a real <thead>. */
function moveHeaderRows(table: HTMLElement, node: PMNode): void {
  const count = headerRowCount(node);
  if (count === 0) return;
  const tbody = Array.from(table.children).find((c) => c.localName === 'tbody');
  if (!tbody) return;
  const rows = Array.from(tbody.children).slice(0, count);
  // A header cell that spans rows past the header rows can't leave the table body (row groups
  // cut spans): such a table keeps its rows where the editor has them.
  for (let r = 0; r < rows.length; r++) {
    for (const cell of Array.from(rows[r]!.children)) {
      const span = Number(cell.getAttribute('rowspan') ?? '1') || 1;
      if (r + span > count) return;
    }
  }
  const thead = table.ownerDocument.createElement('thead');
  for (const row of rows) thead.appendChild(row);
  table.insertBefore(thead, tbody);
}

/**
 * The document's pages as the read-only editor renders them (see the file header). TOCs are
 * empty until fillTocs.
 */
export function serializeBrew(doc: PMNode, options: SerializeBrewOptions = {}): SerializedBrew {
  const target = options.document ?? document;
  const schema = doc.type.schema;
  const base = DOMSerializer.fromSchema(schema);
  const headings: HTMLElement[] = [];
  const tocs: { el: HTMLElement; node: PMNode }[] = [];
  const tables: { el: HTMLElement; node: PMNode }[] = [];
  const textblocks: { el: HTMLElement; node: PMNode }[] = [];
  /** Every element that renders a node (the rest of the inline DOM is mark wrappers). */
  const nodeDoms = new WeakSet<Node>();

  const nodes: Record<string, (node: PMNode) => DOMOutputSpec> = {};
  for (const [name, render] of Object.entries(base.nodes)) {
    if (name === 'text') {
      nodes[name] = render;
      continue;
    }
    nodes[name] = (node: PMNode): DOMOutputSpec => {
      let rendered: Rendered;
      if (name === 'page') rendered = renderPage(node);
      else if (name === 'image') rendered = { dom: new ImageView(node).dom };
      else if (name === 'toc') {
        const el = renderToc(node, target);
        tocs.push({ el, node });
        rendered = { dom: el };
      } else rendered = DOMSerializer.renderSpec(target, render(node), null);

      const { dom, contentDOM } = rendered;
      nodeDoms.add(dom);
      if (isElement(dom)) {
        // ProseMirror (NodeViewDesc.create): a node rendered without a content hole is
        // contenteditable=false, except <br> (TipTap's CSS gives those white-space: normal).
        if (!contentDOM && dom.nodeName !== 'BR' && !dom.hasAttribute('contenteditable')) {
          dom.setAttribute('contenteditable', 'false');
        }
        if (dom.localName === 'img') dom.removeAttribute('loading');
        if (name === 'heading') headings.push(dom);
        if (node.type.spec.tableRole === 'table') tables.push({ el: dom, node });
      }
      if (node.isTextblock && contentDOM) textblocks.push({ el: contentDOM, node });
      // (Element in practice: only text nodes render as text, and they don't come here.)
      return (contentDOM ? { dom, contentDOM } : dom) as DOMOutputSpec;
    };
  }

  const pages = target.createElement('div');
  pages.className = 'pages ProseMirror';
  pages.setAttribute('contenteditable', 'false');
  new DOMSerializer(nodes, base.marks).serializeFragment(doc.content, { document: target }, pages);

  // ProseMirror's textblock hacks (ViewTreeUpdater.addTextblockHacks): a line for empty
  // textblocks and after a trailing inline node, and the separator after an uneditable one.
  for (const { el, node } of textblocks) {
    const last = node.lastChild;
    if (!last || !last.isText || (last.text ?? '').endsWith('\n')) {
      if (options.separators !== false) {
        // The last inline DOM node, inside the mark wrappers around it.
        let parent: Element = el;
        let lastDom = parent.lastChild;
        while (isElement(lastDom) && !nodeDoms.has(lastDom) && lastDom.lastChild) {
          parent = lastDom;
          lastDom = lastDom.lastChild;
        }
        if (isElement(lastDom) && lastDom.getAttribute('contenteditable') === 'false') {
          const img = target.createElement('img');
          img.className = SEPARATOR_CLASS;
          img.alt = '';
          parent.appendChild(img);
        }
      }
      const br = target.createElement('br');
      br.className = TRAILING_BREAK_CLASS;
      el.appendChild(br);
    }
  }

  // Header rows of top-level tables (the editor decorates only those; tables nested in cells
  // keep theirs in the body, as the decoration leaves them).
  for (const { el, node } of tables) {
    if (el.parentElement?.closest('table')) continue;
    moveHeaderRows(el, node);
  }

  // Page ids (PageIndexIds): p1…pN, replacing any author id, as in the editor.
  Array.from(pages.children).forEach((page, i) => {
    page.id = pageDomId(i);
  });

  // Every image loads at once (no loading=lazy anywhere, rawHtml included).
  for (const img of Array.from(pages.querySelectorAll('img[loading]'))) img.removeAttribute('loading');

  return { pages, headings, tocs };
}

/**
 * Fills every toc with its entries, as TocView does. `isExcluded` is the theme's --TOC: exclude
 * (from a laid-out copy); without it every heading up to the toc's depth is listed.
 */
export function fillTocs(serialized: SerializedBrew, doc: PMNode, isExcluded?: (heading: TocHeading) => boolean): void {
  for (const { el, node } of serialized.tocs) {
    const depth = Number(node.attrs.depth) || 3;
    const entries = tocEntries(doc, { depth, isExcluded });
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : 'Contents';
    el.innerHTML = tocInnerHtml(title, entries);
    el.setAttribute(TOC_ENTRIES_ATTR, String(entries.length));
  }
}

/** The document's headings (collectHeadings) with their elements. */
export function headingElements(serialized: SerializedBrew, doc: PMNode): { heading: TocHeading; el: HTMLElement | undefined }[] {
  return collectHeadings(doc).map((heading, i) => ({ heading, el: serialized.headings[i] }));
}

const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster', 'background', 'lowsrc', 'dynsrc'];
const UNSAFE_URL = /^\s*(?:javascript|vbscript|data:(?!image\/(?:png|gif|jpe?g|webp|avif|bmp|x-icon|svg\+xml)[;,]))/i;

/**
 * A last line of defence for a file that is opened outside the app: no script elements, no event
 * handler attributes, no script URLs, no elements that change the document's base, refresh it or
 * pull in other documents. (rawHtml is sanitized when it is stored; this doesn't rely on it.)
 * Returns how many things were removed.
 */
export function stripActiveContent(root: Element): number {
  let removed = 0;
  for (const el of Array.from(root.querySelectorAll('script, base, meta, link, iframe[srcdoc], noscript, template, portal'))) {
    el.remove();
    removed++;
  }
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || (URL_ATTRS.includes(name) && UNSAFE_URL.test(attr.value))) {
        el.removeAttribute(attr.name);
        removed++;
      }
    }
  }
  return removed;
}
