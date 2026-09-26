// The editor pages' navbar items (legacy navbar share and edit items): rendered into the shell's
// navbar through <NavbarPortal slot="items">. Print is in the editor's own toolbar (and Ctrl+P),
// which keeps the navbar narrow enough for phones.
import { Link } from 'react-router';
import { paths } from '@/app/paths';
import { NavDisclosure, NavLinkItem, navbarStyles } from '@/ported/navbar';
import { Icon, toast } from '@/ui';

export interface EditorNavItemsProps {
  /** Share page of the brew (edit mode, once saved). */
  shareId?: string | null;
  /** Link to the editor (the share page, for the brew's authors). */
  editId?: string | null;
}

async function copyShareLink(shareId: string) {
  const url = new URL(paths.share(shareId), window.location.origin).href;
  try {
    await navigator.clipboard.writeText(url);
    toast({ title: 'Share link copied', description: url, tone: 'success' });
  } catch {
    toast({ title: "Couldn't copy the link", description: url, tone: 'warning' });
  }
}

export function EditorNavItems({ shareId, editId }: EditorNavItemsProps) {
  return (
    <>
      {shareId ? (
        <NavDisclosure label="Share" icon={<Icon name="eye" />} tone="teal" collapsible panelLabel="Share" data-testid="nav-share">
          {(close) => (
            <ul className={navbarStyles.panelList}>
              <li>
                <Link className={navbarStyles.panelLink} to={paths.share(shareId)} data-testid="nav-share-view">
                  View the share page
                  <span className={navbarStyles.panelHint}>Read-only; anyone with the link can read it.</span>
                </Link>
              </li>
              <li>
                <button
                  type="button"
                  className={navbarStyles.panelLink}
                  onClick={() => {
                    close();
                    void copyShareLink(shareId);
                  }}
                  data-testid="nav-share-copy"
                >
                  Copy the share link
                </button>
              </li>
            </ul>
          )}
        </NavDisclosure>
      ) : null}
      {editId ? (
        <NavLinkItem to={paths.edit(editId)} tone="green" icon={<Icon name="settings" />} collapsible data-testid="nav-edit">
          Edit
        </NavLinkItem>
      ) : null}
    </>
  );
}
