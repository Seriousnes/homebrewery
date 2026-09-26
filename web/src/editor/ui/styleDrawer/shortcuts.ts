const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The format shortcut as shown to the author. */
export const FORMAT_SHORTCUT = isMac ? '⌘⇧F' : 'Ctrl+Shift+F';
/** The format shortcuts for aria-keyshortcuts. */
export const FORMAT_KEYSHORTCUTS = isMac ? 'Meta+Shift+F Alt+Shift+F' : 'Control+Shift+F Alt+Shift+F';
