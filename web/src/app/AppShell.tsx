// The app shell (plan §9): skip link, navbar (web/src/ported/navbar), site notices and the routed
// page in <main>. It fills the viewport; <main> is the scroll container, and a page that needs a
// fixed-height layout (the editor) can fill it with flex: 1 and min-height: 0. The UiRoot carries
// the design tokens without painting a surface, so theme-styled canvases inherit no chrome styles
// (plan §5); non-editor pages paint their own surface through <SitePage>.
import { type MouseEvent, useMemo, useRef, useState } from 'react';
import { Outlet, useNavigation } from 'react-router';
import { Navbar } from '@/ported/navbar/Navbar';
import { focusElement, UiRoot } from '@/ui';
import styles from './AppShell.module.css';
import { LocalBrewsSignInPrompt } from './LocalBrewsSignInPrompt';
import { NavbarSlotsContext } from './navbarSlotsContext';
import { NotificationBanner } from './NotificationBanner';
import { useRouteFocus } from './useRouteFocus';

const MAIN_CONTENT_ID = 'main-content';

export function AppShell() {
  const [titleSlot, setTitleSlot] = useState<HTMLDivElement | null>(null);
  const [itemsSlot, setItemsSlot] = useState<HTMLDivElement | null>(null);
  const slots = useMemo(() => ({ title: titleSlot, items: itemsSlot }), [titleSlot, itemsSlot]);
  const mainRef = useRef<HTMLElement>(null);
  const navigation = useNavigation();
  const loading = navigation.state === 'loading';
  useRouteFocus(mainRef);

  // Focus <main> without changing the URL hash (share links use #p<n> for pages).
  const skipToMain = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    focusElement(mainRef.current);
  };

  return (
    <UiRoot surface={false} className={styles.shell}>
      <NavbarSlotsContext value={slots}>
        <a href={`#${MAIN_CONTENT_ID}`} className={styles.skip} onClick={skipToMain}>
          Skip to main content
        </a>
        <header className={styles.header}>
          <Navbar titleSlotRef={setTitleSlot} itemsSlotRef={setItemsSlot} />
          {loading ? <div className={styles.progress} aria-hidden="true" data-testid="route-loading" /> : null}
        </header>
        <NotificationBanner focusAfterLast={() => focusElement(mainRef.current)} />
        <LocalBrewsSignInPrompt />
        <main id={MAIN_CONTENT_ID} ref={mainRef} tabIndex={-1} className={styles.main} aria-busy={loading || undefined}>
          <Outlet />
        </main>
      </NavbarSlotsContext>
    </UiRoot>
  );
}
