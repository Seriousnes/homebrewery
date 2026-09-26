// A brew (or draft) stored by a newer version of the editor (docSchemaVersion above this client's):
// this client can't open it without losing what it doesn't know, so it asks for a reload.
import { SitePage } from '@/app/SitePage';
import { Button } from '@/ui';

export function NewerVersionPage() {
  return (
    <SitePage
      title="This brew needs a newer editor"
      lead="It was saved by a newer version of The Homebrewery than the one this page runs. Reload the page to get the latest version."
      data-testid="newer-version-page"
    >
      <Button variant="primary" icon="undo" onClick={() => window.location.reload()}>
        Reload the page
      </Button>
    </SitePage>
  );
}
