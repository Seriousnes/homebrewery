// The home page (plan §9, P7.2): the welcome brew in the full editor, editable locally and never
// saved (autosave off, no drafts). "Create your own" leads to /new, as upstream's floating button.
import { useState } from 'react';
import { Link } from 'react-router';
import { paths } from '@/app/paths';
import { LazyEditorApp } from '@/editor/EditorApp/LazyEditorApp';
import { Icon } from '@/ui';
import styles from './HomeRoute.module.css';
import { welcomeBrew } from './welcomeBrew';

export function HomeEditor() {
  const [initial] = useState(welcomeBrew);
  return (
    <LazyEditorApp
      mode="edit"
      saving="none"
      content={initial.content}
      brew={initial.brew}
      showTitle={false}
      tabTitle={false}
      statusNote={
        <span className={styles.note} data-testid="home-not-saved">
          <Icon name="info" />
          Changes here are not saved
        </span>
      }
      overlay={
        <Link to={paths.new} className={styles.floating} data-testid="home-create">
          Create your own
          <Icon name="plus" />
        </Link>
      }
      data-testid="home-editor"
    />
  );
}
