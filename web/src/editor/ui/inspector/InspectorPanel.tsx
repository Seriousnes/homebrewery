// The inspector as the editor's right panel: a Drawer wired to the UI store's 'inspector' panel
// (open state and width persist), holding <Inspector>. Place it after <SplitMain> in a SplitPanel.
import type { Editor } from '@tiptap/core';
import type { RefObject } from 'react';
import { PANEL_LIMITS, useUiStore } from '@/app/uiStore';
import { Drawer, Spinner } from '@/ui';
import { Inspector, type InspectorProps } from './Inspector';

export interface InspectorPanelProps extends Omit<InspectorProps, 'editor' | 'className' | 'data-testid'> {
  /** The canvas editor (null while it is created: the panel shows a spinner). */
  editor: Editor | null | undefined;
  /** Gets focus when the panel closes with focus inside (its toggle button). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  id?: string;
  className?: string;
}

export function InspectorPanel({ editor, returnFocusRef, id = 'hb-inspector-panel', className, ...inspector }: InspectorPanelProps) {
  const open = useUiStore((s) => s.panels.inspector.open);
  const size = useUiStore((s) => s.panels.inspector.size);
  const setPanelOpen = useUiStore((s) => s.setPanelOpen);
  const setPanelSize = useUiStore((s) => s.setPanelSize);
  return (
    <Drawer
      side="right"
      id={id}
      open={open}
      onOpenChange={(next) => setPanelOpen('inspector', next)}
      title="Inspector"
      size={size}
      onSizeChange={(px) => setPanelSize('inspector', px)}
      minSize={PANEL_LIMITS.inspector.min}
      maxSize={PANEL_LIMITS.inspector.max}
      resizeLabel="Resize inspector"
      closeLabel="Close inspector"
      {...(returnFocusRef ? { returnFocusRef } : {})}
      {...(className ? { className } : {})}
      data-testid="inspector-panel"
    >
      {editor && !editor.isDestroyed ? <Inspector editor={editor} {...inspector} data-testid="inspector" /> : <Spinner label="Loading the editor" />}
    </Drawer>
  );
}
