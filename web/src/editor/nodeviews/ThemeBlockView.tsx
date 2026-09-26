// The theme-block label (plan §6.4, P5.2): a small, non-editable tab over the top-left corner
// of the theme block that holds the selection ("Stat block", "Note" …) with Wide and Frame
// toggles. It is rendered outside the canvas (a portal layer), so the block's children stay
// exactly the content the theme CSS expects. Mounted by the ThemeBlocks plugin
// (themeBlocks/overlay.ts); Shift+Alt+F10 in the editor moves focus here, Escape moves it back.
import { useLayoutEffect, useRef, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from 'react';
import { Button, Portal, Toolbar } from '@/ui';
import type { ThemeBlockOverlayActions, ThemeBlockOverlayStore } from '../themeBlocks/overlayStore';
import styles from './ThemeBlockView.module.css';

export interface ThemeBlockControlsProps {
  store: ThemeBlockOverlayStore;
  actions: ThemeBlockOverlayActions;
}

/** The nearest scrolling ancestor's box (the canvas viewport), or the window. */
function clipRect(el: HTMLElement): { top: number; bottom: number; left: number; right: number } {
  const win = el.ownerDocument.defaultView ?? window;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = win.getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p.getBoundingClientRect();
  }
  return { top: 0, left: 0, bottom: win.innerHeight, right: win.innerWidth };
}

export function ThemeBlockControls({ store, actions }: ThemeBlockControlsProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const panelRef = useRef<HTMLDivElement>(null);
  const block = state.visible ? state.block : null;

  // Place the tab above the block's top-left corner (inside it when there is no room above),
  // and hide it while the corner is scrolled out of the canvas viewport.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const element = block?.element;
    if (!panel || !element) return;
    const win = panel.ownerDocument.defaultView ?? window;
    let frame = 0;
    const place = () => {
      frame = 0;
      if (!element.isConnected) {
        panel.style.visibility = 'hidden';
        return;
      }
      const rect = element.getBoundingClientRect();
      const clip = clipRect(element);
      const height = panel.offsetHeight;
      const above = rect.top - height - 2;
      const top = above >= clip.top ? above : rect.top + 2;
      const left = Math.max(clip.left, Math.min(rect.left, clip.right - panel.offsetWidth));
      panel.style.top = `${Math.round(top)}px`;
      panel.style.left = `${Math.round(left)}px`;
      const outside = rect.bottom < clip.top || top + height > clip.bottom || rect.top > clip.bottom;
      panel.style.visibility = outside ? 'hidden' : '';
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(place);
    };
    place();
    win.addEventListener('scroll', schedule, true);
    win.addEventListener('resize', schedule);
    return () => {
      if (frame) win.cancelAnimationFrame(frame);
      win.removeEventListener('scroll', schedule, true);
      win.removeEventListener('resize', schedule);
    };
  }, [block, state.version]);

  // Shift+Alt+F10: focus the first control.
  const lastFocusRequest = useRef(state.focusRequest);
  useLayoutEffect(() => {
    if (state.focusRequest === lastFocusRequest.current) return;
    lastFocusRequest.current = state.focusRequest;
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [state.focusRequest, block]);

  if (!block) return null;
  const wide = block.classes.includes('wide');
  const frame = block.classes.includes('frame');

  // Escape, and Tab (the controls sit at the end of the page, outside the text's tab order),
  // return to the text.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      actions.returnFocus();
    }
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) actions.setFocused(false);
  };

  return (
    <Portal>
      <div
        ref={panelRef}
        className={styles.panel}
        data-testid="theme-block-controls"
        // Pointer presses keep the editor's focus and selection.
        onMouseDown={(event) => event.preventDefault()}
        onFocus={() => actions.setFocused(true)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        <Toolbar label={`${block.label} block`} className={styles.toolbar}>
          <span className={styles.label} title="Shift+Alt+F10 moves the focus here; Escape returns to the text">
            {block.label}
          </span>
          <Button size="sm" variant="ghost" className={styles.toggle} pressed={wide} onClick={() => actions.toggle('wide')}>
            Wide
          </Button>
          {block.frameable ? (
            <Button size="sm" variant="ghost" className={styles.toggle} pressed={frame} onClick={() => actions.toggle('frame')}>
              Frame
            </Button>
          ) : null}
        </Toolbar>
      </div>
    </Portal>
  );
}
