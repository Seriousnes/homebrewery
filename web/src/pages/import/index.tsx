// /import (P6.1, P6.3): the route module web/src/app/routes.tsx lazy-loads (default export). The
// conversion (convert.ts) and the preview (LazyImportPreview) load on demand, so this chunk stays
// small.
import { ImportPage } from './ImportPage';

export default function ImportRoute() {
  return <ImportPage />;
}
