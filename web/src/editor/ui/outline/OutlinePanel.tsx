// The outline as the editor's left panel: a Drawer wired to the UI store's 'outline' panel
// (open state and width persist), holding <Outline>. Place it before <SplitMain> in a SplitPanel.
import type { Editor } from '@tiptap/core';
import type { RefObject } from 'react';
import { PANEL_LIMITS, useUiStore } from '@/app/uiStore';
import type { PageTracker } from '@/editor/ui/pageNav/pageTracker';
import { Drawer } from '@/ui';
import { Outline } from './Outline';

export interface OutlinePanelProps {
  editor: Editor | null | undefined;
  tracker: PageTracker | null | undefined;
  /** Gets focus when the panel closes with focus inside (its toggle button). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  id?: string;
  className?: string;
}

export function OutlinePanel({ editor, tracker, returnFocusRef, id = 'hb-outline-panel', className }: OutlinePanelProps) {
  const open = useUiStore((s) => s.panels.outline.open);
  const size = useUiStore((s) => s.panels.outline.size);
  const setPanelOpen = useUiStore((s) => s.setPanelOpen);
  const setPanelSize = useUiStore((s) => s.setPanelSize);
  return (
    <Drawer
      side="left"
      id={id}
      open={open}
      onOpenChange={(next) => setPanelOpen('outline', next)}
      title="Outline"
      size={size}
      onSizeChange={(px) => setPanelSize('outline', px)}
      minSize={PANEL_LIMITS.outline.min}
      maxSize={PANEL_LIMITS.outline.max}
      resizeLabel="Resize outline"
      closeLabel="Close outline"
      {...(returnFocusRef ? { returnFocusRef } : {})}
      {...(className ? { className } : {})}
      data-testid="outline-panel"
    >
      <Outline editor={editor} tracker={tracker} />
    </Drawer>
  );
}
