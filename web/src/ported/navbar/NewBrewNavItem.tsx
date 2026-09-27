// Port of legacy client/homebrew/navbar/newbrew.navitem.jsx. Upstream offered "resume draft",
// "from blank" (clearing the localStorage draft) and "from file" (a .txt upload). Here /new keeps
// its draft in IndexedDB (P7.2; the page offers starting over; signed out, each new brew is a
// local brew, issue #4), /import takes files, pasted text and upstream links, and /local lists the
// brews kept in this browser.
import { Link } from 'react-router';
import { paths } from '@/app/paths';
import { Icon } from '@/ui';
import { NavDisclosure } from './NavDisclosure';
import styles from './Navbar.module.css';

export function NewBrewNavItem() {
  return (
    <NavDisclosure label="New" icon={<Icon name="plus" />} tone="purple" collapsible panelLabel="New brew" data-testid="nav-new">
      <ul className={styles.panelList}>
        <li>
          <Link className={styles.panelLink} to={paths.new}>
            New brew
            <span className={styles.panelHint}>No account needed: signed out, it is kept in this browser.</span>
          </Link>
        </li>
        <li>
          <Link className={styles.panelLink} to={paths.import}>
            Import a brew
            <span className={styles.panelHint}>From a .txt file, pasted text or a Homebrewery share link.</span>
          </Link>
        </li>
        <li>
          <Link className={styles.panelLink} to={paths.local} data-testid="nav-local-brews">
            Brews on this device
            <span className={styles.panelHint}>Open, download or upload brews kept in this browser.</span>
          </Link>
        </li>
      </ul>
    </NavDisclosure>
  );
}
