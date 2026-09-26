// TipTap wrapper for the pagination plugin:
//
//   buildEditorExtensions({ extensions: [Pagination.configure({ isReady: () => fontsReady })] })
//
// (paginatedExtensions() in editor/paginatedExtensions.ts adds the section, seam-editing and
// block-type commands too.) Configure the editor with shouldRerenderOnTransaction: false
// (pagination dispatches often).
//
// It also
// - keeps the section settings of auto pages in sync with their section's first page
//   (sections.ts);
// - replaces TipTap's updateAttributes command for nodes: attribute steps instead of
//   setNodeMarkup, so undo of a formatting change survives pagination re-joining and re-splitting
//   the block, and section settings of an auto page go to its section's first page
//   (fragments.ts). Marks keep TipTap's implementation.
import { Extension } from '@tiptap/core';
import { updateAttributes } from './fragments';
import { paginationPlugin, type PaginationOptions } from './plugin';
import { sectionSyncPlugin } from './sections';

export const Pagination = Extension.create<PaginationOptions>({
  name: 'hbPagination',

  addOptions() {
    return {};
  },

  addCommands() {
    return { updateAttributes };
  },

  addProseMirrorPlugins() {
    return [paginationPlugin(this.options), sectionSyncPlugin()];
  },
});
