// The / route: the welcome brew in the editor (HomeEditor). It names the page for screen readers
// (the tab title and an h1, which also takes the focus after a client-side navigation here),
// since the page itself is the editor.
import { usePageTitle } from '@/app/usePageTitle';
import { HomeEditor } from './HomeEditor';
import styles from './HomeRoute.module.css';

export default function HomeRoute() {
  usePageTitle(null);
  return (
    <>
      <h1 className={styles.heading} data-route-focus="" tabIndex={-1}>
        The Homebrewery
      </h1>
      <HomeEditor />
    </>
  );
}
