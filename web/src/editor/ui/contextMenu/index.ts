// The editor's own right-click menu: register HbContextMenu with the editable editor's extensions
// and mount <ContextMenuHost editor={editor} /> once.
export { ContextMenuHost, type ContextMenuHostProps } from './ContextMenuHost';
export { NATIVE_MENU_HINT, showProperties } from './hostActions';
export { HbContextMenu, onContextMenuRequest, type ContextMenuListener, type ContextMenuRequest } from './contextMenuExtension';
export { blockTarget, contextMenuContext, contextMenuEntries, deleteBlock, type ContextMenuContext, type ContextMenuDeps } from './contextMenuModel';
