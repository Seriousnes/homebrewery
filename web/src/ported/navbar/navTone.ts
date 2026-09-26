import styles from './Navbar.module.css';

/** Upstream's nav item colours (legacy navbar.less color classes), shown as the accent underline. */
export type NavTone = 'purple' | 'yellow' | 'teal' | 'green' | 'red' | 'orange' | 'blue' | 'grey';

export function toneClass(tone: NavTone | undefined): string | undefined {
  return tone ? styles[tone] : undefined;
}
