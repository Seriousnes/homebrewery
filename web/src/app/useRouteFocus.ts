import { type RefObject, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * After a client-side navigation to another path, move focus to the new page (its
 * [data-route-focus] element, else its first h1, else <main>) and scroll <main> to the top, so
 * keyboard and screen reader users start at the new content, as after a full page load. Focus
 * the new page already placed inside <main> (an editor, an autofocus field) or in an open dialog
 * or popover is left alone. The first render (a full page load) is left to the browser.
 */
export function useRouteFocus(mainRef: RefObject<HTMLElement | null>): void {
  const { pathname, hash } = useLocation();
  const previous = useRef(pathname);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const main = mainRef.current;
    if (!main) return;
    if (!hash) main.scrollTop = 0;
    const active = main.ownerDocument.activeElement;
    if (active instanceof HTMLElement && active !== main.ownerDocument.body) {
      if (main.contains(active) && active !== main) return;
      if (active.closest('[data-hb-portal-root]')) return;
    }
    const target = main.querySelector<HTMLElement>('[data-route-focus]') ?? main.querySelector<HTMLElement>('h1') ?? main;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }, [pathname, hash, mainRef]);
}
