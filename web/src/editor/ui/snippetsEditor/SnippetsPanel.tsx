// The Snippets panel (a left Drawer next to Style) and its toggle for the editor's app bar. With
// useSnippetsEditor (the store for the page's lifetime):
//
//   const snippetsStore = useSnippetsEditor(snippets, setSnippets);   // brew snippets ↔ autosave
//   <EditorAppBar panelToggles={<SnippetsToggle ref={snippetsToggle} />} … />
//   <SnippetsPanel store={snippetsStore} brewTitle={title} themeSnippets={chain?.snippets}
//     returnFocusRef={snippetsToggle} />
import type { Ref, RefObject } from 'react';
import type { ThemeSnippetRef } from '@/editor/canvas/themeLoader';
import { Drawer, type DrawerSide, IconButton } from '@/ui';
import { SnippetsEditor } from './SnippetsEditor';
import type { SnippetsEditorStore } from './snippetsEditorStore';
import { SNIPPETS_PANEL_ID, SNIPPETS_PANEL_LIMITS, type SnippetsPanelStoreApi, useSnippetsPanel } from './snippetsPanelState';

export interface SnippetsToggleProps {
  ref?: Ref<HTMLButtonElement | null>;
  panel?: SnippetsPanelStoreApi;
}

/** The app bar button that opens and closes the Snippets panel. */
export function SnippetsToggle({ ref, panel }: SnippetsToggleProps) {
  const { open, toggle } = useSnippetsPanel(panel);
  return (
    <IconButton
      ref={ref}
      icon="code"
      label="Snippets"
      tooltip="bottom"
      pressed={open}
      aria-expanded={open}
      aria-controls={open ? SNIPPETS_PANEL_ID : undefined}
      onClick={toggle}
      data-testid="toggle-snippets"
    />
  );
}

export interface SnippetsPanelProps {
  store: SnippetsEditorStore;
  brewTitle: string;
  themeSnippets?: readonly ThemeSnippetRef[] | null;
  readOnly?: boolean;
  /** Where it docks (default 'left', next to the Style drawer). */
  side?: DrawerSide;
  /** Gets focus when the panel closes with focus inside (its toggle). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  panel?: SnippetsPanelStoreApi;
  className?: string;
}

export function SnippetsPanel({ store, brewTitle, themeSnippets, readOnly, side = 'left', returnFocusRef, panel, className }: SnippetsPanelProps) {
  const { open, size, setOpen, setSize } = useSnippetsPanel(panel);
  return (
    <Drawer
      side={side}
      id={SNIPPETS_PANEL_ID}
      open={open}
      onOpenChange={setOpen}
      title="Snippets"
      size={size}
      onSizeChange={setSize}
      minSize={SNIPPETS_PANEL_LIMITS.min}
      maxSize={SNIPPETS_PANEL_LIMITS.max}
      resizeLabel="Resize snippets panel"
      closeLabel="Close snippets panel"
      {...(returnFocusRef ? { returnFocusRef } : {})}
      {...(className ? { className } : {})}
      data-testid="snippets-panel"
    >
      <SnippetsEditor store={store} brewTitle={brewTitle} themeSnippets={themeSnippets ?? null} readOnly={readOnly ?? false} />
    </Drawer>
  );
}
