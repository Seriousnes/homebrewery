// Port of legacy client/homebrew/navbar/help.navitem.jsx ("need help?"). Upstream's "migrate"
// entry (legacy to V3 renderer) has no counterpart; importing lives under "New".
import { siteLinks } from '@/app/siteLinks';
import { VisuallyHidden } from '@/ui';
import { HelpIcon } from './navIcons';
import { NavDisclosure } from './NavDisclosure';
import styles from './Navbar.module.css';

function ExternalLink({ href, children, hint }: { href: string; children: string; hint: string }) {
  return (
    <a className={styles.panelLink} href={href} target="_blank" rel="noopener noreferrer">
      <span className={styles.panelLinkRow}>
        {children}
        <span aria-hidden="true">↗</span>
        <VisuallyHidden>(opens in a new tab)</VisuallyHidden>
      </span>
      <span className={styles.panelHint}>{hint}</span>
    </a>
  );
}

export function HelpNavItem() {
  return (
    <NavDisclosure label="Help" icon={<HelpIcon />} tone="grey" collapsible panelLabel="Help" data-testid="nav-help">
      <ul className={styles.panelList}>
        <li>
          <ExternalLink href={siteLinks.reportIssue} hint="Tell us about a bug or a problem.">
            Report an issue
          </ExternalLink>
        </li>
        <li>
          <ExternalLink href={siteLinks.faq} hint="Answers to common questions.">
            FAQ
          </ExternalLink>
        </li>
      </ul>
    </NavDisclosure>
  );
}
