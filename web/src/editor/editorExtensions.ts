// The extension list for an editing (or read-only) editor: the schema plus the behaviour that
// every editor needs. Editor lanes add their own extensions on top:
//
//   const editor = new Editor({
//     extensions: buildEditorExtensions({
//       extensions: [PageWithView, paginationExtension],   // Page.extend({ addNodeView }) replaces Page
//     }),
//   });
//
// NodeViews: extend the schema extension (e.g. `Page.extend({ addNodeView() {…} })`) and pass it
// in `extensions`; it replaces the extension with the same name in place. Don't change the
// schema that way (attrs, content, parse rules): shared/schema-manifest.json is generated from
// `schemaExtensions` alone. TipTap ignores editorProps.nodeViews, so this is the way to add them.
import type { AnyExtension } from '@tiptap/core';
import { Dropcursor, Gapcursor, UndoRedo, type DropcursorOptions, type UndoRedoOptions } from '@tiptap/extensions';
import { createSchemaExtensions, type SchemaExtensionOptions } from './schema';
import { HeadingIds, PageIds, PageIndexIds, PagesRoot } from './schema/plugins';

export interface BuildEditorExtensionsOptions {
  /** Options for schema extensions that don't change the schema (e.g. link.openOnClick). */
  schema?: SchemaExtensionOptions;
  /** Undo/redo (prosemirror-history). false to leave it out (e.g. read-only share view). */
  history?: false | Partial<UndoRedoOptions>;
  /** Drop cursor while dragging. false to leave it out. */
  dropcursor?: false | Partial<DropcursorOptions>;
  /** Gap cursor between atoms (column breaks, spacers, tables). */
  gapcursor?: boolean;
  /**
   * Extra extensions. One whose name matches an extension already in the list replaces it in
   * place (NodeViews); the others are appended in order.
   */
  extensions?: AnyExtension[];
}

/**
 * schemaExtensions + heading ids + page ids (pid) + page DOM ids (p{n}) + the `pages` root class
 * + undo/redo, drop cursor and gap cursor, plus `opts.extensions`.
 */
export function buildEditorExtensions(opts: BuildEditorExtensionsOptions = {}): AnyExtension[] {
  const list: AnyExtension[] = [
    ...createSchemaExtensions(opts.schema),
    HeadingIds,
    PageIds,
    PageIndexIds,
    PagesRoot,
  ];
  if (opts.history !== false) list.push(UndoRedo.configure(opts.history ?? {}));
  if (opts.dropcursor !== false) list.push(Dropcursor.configure(opts.dropcursor ?? {}));
  if (opts.gapcursor !== false) list.push(Gapcursor);

  for (const extension of opts.extensions ?? []) {
    const index = list.findIndex((e) => e.name === extension.name);
    if (index >= 0) list[index] = extension;
    else list.push(extension);
  }
  return list;
}
