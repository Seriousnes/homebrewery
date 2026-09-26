import { type RefObject, useEffect, useEffectEvent } from 'react';
import { isInLaterLayer, layerOf, registerEscape } from './layers';
import { type ElementOrRef, resolveElement } from './useFloating';

export type DismissReason = 'escape' | 'outside' | 'focus-out';

export interface DismissOptions {
  /** The floating element (its portal layer counts as inside). */
  floatingRef: RefObject<HTMLElement | null>;
  /** The trigger (element or ref): pointer presses and focus there don't dismiss. */
  anchorRef?: ElementOrRef;
  onDismiss: (reason: DismissReason) => void;
  escape?: boolean;
  outsidePress?: boolean;
  /** Dismiss when focus moves outside (default false). */
  focusOut?: boolean;
}

/**
 * Close a non-modal layer on Escape (top-most layer only), a pointer press outside, or focus
 * leaving. Presses and focus inside layers opened from this one (a submenu, a tooltip) count as
 * inside.
 */
export function useDismiss(
  open: boolean,
  { floatingRef, anchorRef, onDismiss, escape = true, outsidePress = true, focusOut = false }: DismissOptions,
): void {
  const dismiss = useEffectEvent((reason: DismissReason) => onDismiss(reason));

  useEffect(() => {
    if (!open) return;
    const doc = floatingRef.current?.ownerDocument ?? document;
    const isInside = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      const floating = floatingRef.current;
      const layer = layerOf(floating) ?? floating;
      return Boolean(
        layer?.contains(target) || resolveElement(anchorRef)?.contains(target) || isInLaterLayer(target, layer),
      );
    };
    const cleanups: (() => void)[] = [];
    if (escape) cleanups.push(registerEscape(() => dismiss('escape'), doc));
    if (outsidePress) {
      const onPointerDown = (event: PointerEvent) => {
        if (!isInside(event.target)) dismiss('outside');
      };
      doc.addEventListener('pointerdown', onPointerDown, true);
      cleanups.push(() => doc.removeEventListener('pointerdown', onPointerDown, true));
    }
    if (focusOut) {
      const onFocusIn = (event: FocusEvent) => {
        if (!isInside(event.target)) dismiss('focus-out');
      };
      doc.addEventListener('focusin', onFocusIn);
      cleanups.push(() => doc.removeEventListener('focusin', onFocusIn));
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [open, escape, outsidePress, focusOut, floatingRef, anchorRef]);
}
