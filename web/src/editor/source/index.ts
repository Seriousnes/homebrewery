// "Edit source" (T5): the document's HTML as readable source, parsed back through the schema.
//   flow.ts       sections and their merged flows (auto pages and split blocks never show)
//   serialize.ts  the source view printer
//   parse.ts      source → nodes, with the parse report
//   apply.ts      scope targets and the one-step transaction
export { buildApplyTransaction, SourceApplyError, sourceOf, targetExists, targetFor, type SourceScope, type SourceSnapshot, type SourceTarget } from './apply';
export { joinFragments, sameBlock, sectionsOf, type FlowItem, type Section } from './flow';
export { normalizeSourceWhitespace, parseBlocksSource, parseSectionsSource, type ParsedBlocks, type ParsedSections, type SourceProblem, type SourceProblemKind } from './parse';
export { SourcePrinter, sourceSerializer } from './serialize';

import type { Schema } from '@tiptap/pm/model';
import type { SourceTarget } from './apply';
import { parseBlocksSource, parseSectionsSource, type ParsedBlocks, type ParsedSections } from './parse';

/** Parses `text` the way `target` needs it (blocks for the selection, sections otherwise). */
export function parseSourceFor(schema: Schema, target: SourceTarget, text: string, rawHtmlBefore: readonly string[] = []): ParsedBlocks | ParsedSections {
  return target.scope === 'selection' ? parseBlocksSource(schema, text, rawHtmlBefore) : parseSectionsSource(schema, text, rawHtmlBefore);
}
