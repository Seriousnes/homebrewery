import { use, useSyncExternalStore } from 'react';
import { UiColorSchemeContext } from '@/ui';

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY) : null;
  media?.addEventListener?.('change', onChange);
  return () => media?.removeEventListener?.('change', onChange);
}
const systemDark = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(QUERY).matches : false);

/** The nearest UiRoot's colour scheme, with 'system' resolved through prefers-color-scheme. */
export function useResolvedScheme(): 'light' | 'dark' {
  const scheme = use(UiColorSchemeContext);
  const dark = useSyncExternalStore(subscribe, systemDark, () => false);
  if (scheme === 'system') return dark ? 'dark' : 'light';
  return scheme;
}
