// Types TanStack Query's `meta` on queries and mutations as ApiRequestMeta, so
// `meta: { errorPolicy: 'manual', errorTitle: '…' }` is checked everywhere in the app.
import type { ApiRequestMeta } from './errorPolicy';

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: ApiRequestMeta;
    mutationMeta: ApiRequestMeta;
  }
}
