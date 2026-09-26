// The Style drawer as an editor panel: a Drawer wired to the UI store's 'style' panel (open state
// and size persist), holding <StyleDrawer>. Place it in a SplitPanel next to <SplitMain> (side
// 'left' before it, 'right' after it) or, with side 'bottom', in a column SplitPanel.
import type { RefObject } from 'react';
import { PANEL_LIMITS, useUiStore } from '@/app/uiStore';
import { Drawer, type DrawerSide } from '@/ui';
import { StyleDrawer, type StyleDrawerProps } from './StyleDrawer';

export interface StylePanelProps extends Omit<StyleDrawerProps, 'className' | 'data-testid'> {
  /** Where it docks (default 'left', where upstream's editor had the CSS). */
  side?: DrawerSide;
  /** Gets focus when the panel closes with focus inside (its toggle button). */
  returnFocusRef?: RefObject<HTMLElement | null>;
  id?: string;
  className?: string;
}

export function StylePanel({ side = 'left', returnFocusRef, id = 'hb-style-panel', className, ...drawer }: StylePanelProps) {
  const open = useUiStore((s) => s.panels.style.open);
  const size = useUiStore((s) => s.panels.style.size);
  const setPanelOpen = useUiStore((s) => s.setPanelOpen);
  const setPanelSize = useUiStore((s) => s.setPanelSize);
  return (
    <Drawer
      side={side}
      id={id}
      open={open}
      onOpenChange={(next) => setPanelOpen('style', next)}
      title="Style"
      size={size}
      onSizeChange={(px) => setPanelSize('style', px)}
      minSize={PANEL_LIMITS.style.min}
      maxSize={PANEL_LIMITS.style.max}
      resizeLabel="Resize style drawer"
      closeLabel="Close style drawer"
      {...(returnFocusRef ? { returnFocusRef } : {})}
      {...(className ? { className } : {})}
      data-testid="style-panel"
    >
      <StyleDrawer {...drawer} />
    </Drawer>
  );
}
