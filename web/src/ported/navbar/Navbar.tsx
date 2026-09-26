// Port of legacy client/homebrew/navbar/navbar.jsx and the uiPage.jsx item set: the brand link,
// the page's title and items (slots filled through <NavbarPortal>), then New, Vault, Recent,
// Help and the account item. Upstream's NaturalCrit logo, version/changelog and Patreon items
// are not ported.
import type { Ref } from 'react';
import { Link } from 'react-router';
import { paths } from '@/app/paths';
import { AccountNavItem } from './AccountNavItem';
import { HelpNavItem } from './HelpNavItem';
import { BrandMark } from './navIcons';
import styles from './Navbar.module.css';
import { NewBrewNavItem } from './NewBrewNavItem';
import { RecentNavItem } from './RecentNavItem';
import { VaultNavItem } from './VaultNavItem';

export interface NavbarProps {
  /** Receives the element pages render their title into. */
  titleSlotRef?: Ref<HTMLDivElement>;
  /** Receives the element pages render their own items into. */
  itemsSlotRef?: Ref<HTMLDivElement>;
}

export function Navbar({ titleSlotRef, itemsSlotRef }: NavbarProps) {
  return (
    <nav className={styles.nav} aria-label="Main" data-testid="navbar">
      <Link to={paths.home} className={styles.brand}>
        <BrandMark className={styles.brandMark} />
        <span className={styles.collapsible}>The Homebrewery</span>
      </Link>
      <div ref={titleSlotRef} className={styles.title} data-testid="navbar-title" />
      <div ref={itemsSlotRef} className={styles.pageItems} data-testid="navbar-page-items" />
      <ul className={styles.items}>
        <li>
          <NewBrewNavItem />
        </li>
        <li>
          <VaultNavItem />
        </li>
        <li>
          <RecentNavItem />
        </li>
        <li>
          <HelpNavItem />
        </li>
        <li>
          <AccountNavItem />
        </li>
      </ul>
    </nav>
  );
}
