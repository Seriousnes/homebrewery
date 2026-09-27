// /local/:localId (issue #4): a brew from this browser's local brew library, in the editor. A brew
// that isn't on this device (another browser's link, deleted, uploaded) gets a page saying so.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { PageLoading } from '@/app/PageLoading';
import { paths } from '@/app/paths';
import { SitePage } from '@/app/SitePage';
import { isOpenableVersion } from '@/editor/EditorApp/editorAppModel';
import { defaultLocalBrews, type LocalBrew } from '@/editor/local/localBrews';
import { NewerVersionPage } from '@/pages/edit/NewerVersionPage';
import { LocalBrewEditor } from './LocalBrewEditor';
import styles from './local.module.css';

type Loaded = { state: 'loading' } | { state: 'missing' } | { state: 'ready'; brew: LocalBrew };

export function LocalBrewSession({ localId }: { localId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    void defaultLocalBrews()
      .get(localId)
      .catch(() => null)
      .then((brew) => {
        if (!cancelled) setLoaded(brew ? { state: 'ready', brew } : { state: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [localId]);

  if (loaded.state === 'loading') return <PageLoading label="Loading the brew…" />;
  if (loaded.state === 'missing') return <LocalBrewMissing />;
  if (!isOpenableVersion(loaded.brew.docSchemaVersion)) return <NewerVersionPage />;
  return <LocalBrewEditor brew={loaded.brew} />;
}

function LocalBrewMissing() {
  return (
    <SitePage title="This brew isn’t on this device" data-testid="local-brew-missing">
      <p className={styles.pageText}>
        Brews made without uploading them stay in the browser that made them. This one may have been deleted, uploaded to an account, or
        made in another browser.
      </p>
      <p className={styles.pageText}>
        <Link className={styles.link} to={paths.local}>
          Brews on this device
        </Link>
        {' · '}
        <Link className={styles.link} to={paths.new}>
          New brew
        </Link>
      </p>
    </SitePage>
  );
}
