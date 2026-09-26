import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Adds the class `pages` to the ProseMirror root, which holds only page elements (plan §5):
 * div.hb-canvas › div.pages.ProseMirror › div.page.
 */
export const PagesRoot = Extension.create({
  name: 'hbPagesRoot',

  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey('hbPagesRoot'), props: { attributes: { class: 'pages' } } })];
  },
});
