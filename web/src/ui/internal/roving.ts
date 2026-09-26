// Roving tabindex for toolbars (WAI-ARIA APG): the toolbar is one Tab stop; arrow keys move
// focus between its items. Items are the focusable elements inside the toolbar's DOM (portaled
// menus are outside it), minus disabled ones.
import { focusElement, getFocusables } from './focus';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week']);

/** Focusable, enabled items of a roving container, in DOM order. */
export function rovingItems(root: HTMLElement): HTMLElement[] {
  return getFocusables(root).filter((el) => !(el as HTMLButtonElement).disabled && el !== root);
}

/** Make `active` (or the current tab stop, or the first item) the only item with tabindex 0. */
export function syncRovingTabIndex(root: HTMLElement, active?: HTMLElement | null): HTMLElement | null {
  const items = rovingItems(root);
  const current =
    (active && items.includes(active) ? active : null) ??
    items.find((el) => el.getAttribute('tabindex') === '0') ??
    items[0] ??
    null;
  for (const item of items) {
    const value = item === current ? '0' : '-1';
    if (item.getAttribute('tabindex') !== value) item.setAttribute('tabindex', value);
  }
  return current;
}

/** True when arrow keys belong to the element itself (text fields, text areas, editable content). */
export function ownsArrowKeys(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

export type RovingOrientation = 'horizontal' | 'vertical';

/**
 * Handle an arrow/Home/End key on a roving container: move focus and the tab stop. Returns true
 * when the key was used (the caller then prevents the default).
 */
export function moveRovingFocus(
  root: HTMLElement,
  key: string,
  target: Element,
  orientation: RovingOrientation,
  rtl = false,
): boolean {
  const items = rovingItems(root);
  const index = items.findIndex((el) => el === target || el.contains(target));
  if (index < 0 || items.length === 0) return false;
  const forward = orientation === 'horizontal' ? (rtl ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown';
  const backward = orientation === 'horizontal' ? (rtl ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp';
  let next: number;
  if (key === forward) next = (index + 1) % items.length;
  else if (key === backward) next = (index - 1 + items.length) % items.length;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = items.length - 1;
  else return false;
  const item = items[next];
  if (!item) return false;
  syncRovingTabIndex(root, item);
  focusElement(item, { preventScroll: false });
  return true;
}
