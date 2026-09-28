// One-way helper of the source dialog: Homebrewery markdown (HBFM) → source HTML, to paste into
// the source. The import pipeline's rendering (marked-hbfm port, sanitizer, schema parse rules)
// without its layout probe: page markers, footers and absolutely positioned objects stay in the
// flow here (as spans and raw HTML); a full import (Import page) lifts them.
import type { Schema } from '@tiptap/pm/model';
import { createHbfmRenderer } from '../import/hbfm/renderer';
import { buildPageElement, pageLine, pageShellFromTags, splitPages, stripPageLine } from '../import/pages';
import { markMultilineDefinitionLists } from '../schema/nodes/lists';
import { headingSlugSourceFromHtml, isGeneratedSlug } from '../schema/slug';
import { parseBlocksSource, parseSectionsSource, type SourceProblem } from './parse';
import { SourcePrinter } from './serialize';

export interface MarkdownSource {
  /** Source HTML for the dialog (blocks, or div.page sections). */
  text: string;
  problems: SourceProblem[];
}

/**
 * Converts `markdown` to source text. `sections`: every `\page` starts a section (div.page with
 * the line's classes, styles and attributes); else the pages' blocks are one run.
 */
export function markdownToSource(schema: Schema, markdown: string, sections: boolean): MarkdownSource {
  const pages = splitPages(markdown.replaceAll('\r\n', '\n'));
  const renderer = createHbfmRenderer();
  const bodies = pages.map(stripPageLine);
  // Twice, as the import does: cross-page variables resolve on the second pass.
  bodies.forEach((body, i) => renderer.render(body, i));
  const inert = document.implementation.createHTMLDocument('');
  const elements = bodies.map((body, i) => {
    const line = pageLine(pages[i] ?? '');
    return buildPageElement(inert, pageShellFromTags(line ? renderer.pageLineTags(line) : null), renderer.render(body, i));
  });
  for (const el of elements) {
    // The multi-line form of definition lists is only visible in the rendered text nodes.
    markMultilineDefinitionLists(el);
    // Slugs marked-hbfm generated are not ids the author chose (the editor generates its own); other
    // ids are kept.
    for (const h of Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
      const id = h.getAttribute('id');
      if (id !== null && isGeneratedSlug(id, headingSlugSourceFromHtml(h.innerHTML))) h.removeAttribute('id');
    }
  }
  const printer = new SourcePrinter(schema);
  if (sections) {
    const parsed = parseSectionsSource(schema, elements.map((el) => el.outerHTML).join('\n'));
    return { text: printer.printSections(parsed.sections.map((s) => ({ page: s.page, items: s.blocks.map((node) => ({ node })) }))), problems: parsed.problems };
  }
  const parsed = parseBlocksSource(schema, elements.map((el) => el.firstElementChild!.innerHTML).join('\n'));
  return { text: printer.printBlocks(parsed.blocks), problems: parsed.problems };
}
