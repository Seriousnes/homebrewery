// Everything a paginated editor needs on top of buildEditorExtensions (plan §4):
//
//   const gate = useMemo(() => createCanvasGate(), []);
//   const extensions = useMemo(() => paginatedExtensions({ gate }), [gate]);
//   <EditorCanvas gate={gate} extensions={extensions} … />
//
//   Pagination         the paginator (plugin, scheduler, image-load trigger, waiting pages, parity,
//                      split-block attribute sharing, orphaned fragments) and the section sync
//   Sections           insertPageBreak (Mod-Enter), setSectionAttrs, removeSectionBreak
//   SeamEditing        Backspace / Delete / ArrowLeft / ArrowRight / Enter at page seams
//   BlockTypeCommands  history-safe setNode / toggleNode (setParagraph, toggleHeading, …)
//
// The fonts, theme and user CSS triggers come from EditorCanvas (REPAGINATE from page 0).
import type { AnyExtension } from '@tiptap/core';
import { BlockTypeCommands } from './commands/blockType';
import { SeamEditing } from './commands/continuation';
import { Sections } from './commands/sections';
import { Pagination, type PaginationOptions } from './pagination';

export interface PaginatedExtensionsOptions extends Omit<PaginationOptions, 'isReady'> {
  /** The canvas gate (createCanvasGate()): pagination waits while theme, CSS or fonts load. */
  gate?: { isReady: () => boolean } | null;
  /** Another condition pagination waits for (combined with the gate). */
  isReady?: () => boolean;
}

/** The pagination, section, seam-editing and block-type extensions, configured for `opts.gate`. */
export function paginatedExtensions(opts: PaginatedExtensionsOptions = {}): AnyExtension[] {
  const { gate, isReady, ...pagination } = opts;
  const ready = () => (gate ? gate.isReady() : true) && (isReady ? isReady() : true);
  return [Pagination.configure({ ...pagination, isReady: ready }), Sections, SeamEditing, BlockTypeCommands];
}
