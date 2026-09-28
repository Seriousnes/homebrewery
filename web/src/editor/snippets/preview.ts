// Snippet previews (the Insert snippet gallery): what a snippet inserts, as static pages.
//
// - Markdown snippets: the result of the inserter's own pipeline (prepare(): the generator's
//   markdown → snippetToDoc: HBFM → sanitize → layout probe lift → schema), on a page of its own.
//   Page snippets (`\page`) show their pages, as insertPagesTr keeps them (blank pages at either
//   end dropped).
// - Native snippets: the editor's current page with the action applied (the footer from the
//   brew's own heading, the page number, a page break); the table of contents on a page of its
//   own, listing the brew's headings.
//
// renderPreviewPages turns a preview into DOM: serializeBrew's read-only editor DOM (the CSS
// contract, NodeView chrome, TOC entries) without ids, which would repeat the editor's (p1…, heading
// ids), and without the ProseMirror class, so the editor's own root stays the only one.
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { fillTocs, serializeBrew, stripActiveContent } from '../export/serialize';
import { pageIndexAt } from '../pagination/boundary';
import { pagesFromJson, type SnippetDoc } from './insertSnippet';
import type { NativeSnippetAction } from './native';
import { INSERTED_TOC_ATTRS, nativeActionTr } from './nativeCommands';
import { hasEmptyFlow, isBlankPage } from './sections';

export interface SnippetPreview {
  /** The pages to show (a doc node), or null when the snippet shows nothing. */
  doc: PMNode | null;
  /** The document TOCs list (the brew, for the native table of contents). Default: `doc`. */
  tocSource?: PMNode;
  /** 'content': crop to the flow's content (block snippets); 'page': whole pages. */
  fit: 'content' | 'page';
  /** CSS the snippet adds to the brew's style (applied to the preview too). */
  style: string;
  /** A sentence for the preview's caption (what shows, or why nothing does). */
  note: string | null;
}

/** Page attributes that change the page itself (not only the flow). */
function hasPageChrome(page: PMNode): boolean {
  const a = page.attrs as { markers?: unknown[]; objects?: unknown[]; footer?: unknown; pageNumber?: unknown };
  return Boolean(a.markers?.length || a.objects?.length || a.footer || a.pageNumber);
}

/** The preview of a converted markdown snippet (SnippetDoc from the inserter's prepare()). */
export function markdownPreview(schema: Schema, snippet: SnippetDoc): SnippetPreview {
  let pages = pagesFromJson(schema, snippet.pages);
  const style = snippet.style;
  const styleNote = style.trim() ? "Also adds CSS to the brew's style." : null;
  if (snippet.pageSnippet || pages.length > 1) {
    while (pages.length && isBlankPage(pages[pages.length - 1]!)) pages = pages.slice(0, -1);
    while (pages.length && isBlankPage(pages[0]!)) pages = pages.slice(1);
    if (!pages.length) return { doc: null, fit: 'page', style, note: styleNote ?? 'This snippet adds nothing.' };
    const count = `Inserts ${pages.length} page${pages.length === 1 ? '' : 's'} after this section.`;
    return { doc: schema.topNodeType.create(null, pages), fit: 'page', style, note: styleNote ? `${count} ${styleNote}` : count };
  }
  const page = pages[0];
  if (!page || (hasEmptyFlow(page) && !hasPageChrome(page))) return { doc: null, fit: 'page', style, note: styleNote ?? 'This snippet adds nothing.' };
  const fit = hasEmptyFlow(page) || hasPageChrome(page) ? 'page' : 'content';
  return { doc: schema.topNodeType.create(null, [page]), fit, style, note: styleNote };
}

/** The preview of a native snippet in the editor's current state (nothing is dispatched). */
export function nativePreview(state: EditorState, action: NativeSnippetAction): SnippetPreview {
  const { schema } = state;
  if (action.kind === 'toc') {
    const toc = schema.nodes.toc;
    if (!toc) return { doc: null, fit: 'page', style: '', note: null };
    const page = schema.nodes.page!.create(null, [toc.create(INSERTED_TOC_ATTRS)]);
    return { doc: schema.topNodeType.create(null, [page]), tocSource: state.doc, fit: 'content', style: '', note: "Lists the brew's headings and keeps up with them." };
  }
  const tr = nativeActionTr(state, action);
  if (!tr) return { doc: null, fit: 'page', style: '', note: 'Nothing to change here.' };
  // The state's own follow-ups (the section sync copies a section setting to its auto pages).
  let doc = tr.doc;
  try {
    doc = state.applyTransaction(tr).state.doc;
  } catch {
    // A plugin that can't run on a copy: the transaction's own document.
  }
  const index = pageIndexAt(doc, Math.min(tr.selection.head, doc.content.size));
  const indices = action.kind === 'pageBreak' && index > 0 ? [index - 1, index] : [index];
  const pages = indices.map((i) => doc.child(i));
  const note = action.kind === 'pageBreak' ? 'The current page, split at the cursor.' : 'The current page with the change.';
  return { doc: schema.topNodeType.create(null, pages), tocSource: doc, fit: 'page', style: '', note };
}

/**
 * The preview's pages as the read-only editor renders them: div.pages › div.page… (put it in a
 * div.hb-canvas so the theme and brew CSS apply). Null when the preview has no pages.
 */
export function renderPreviewPages(preview: SnippetPreview, target: Document = document): HTMLElement | null {
  if (!preview.doc) return null;
  const serialized = serializeBrew(preview.doc, { document: target });
  fillTocs(serialized, preview.tocSource ?? preview.doc);
  const pages = serialized.pages;
  pages.className = 'pages';
  for (const el of [pages, ...Array.from(pages.querySelectorAll('[id]'))]) el.removeAttribute('id');
  stripActiveContent(pages);
  return pages;
}
