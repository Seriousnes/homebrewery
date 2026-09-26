import { useEffect } from 'react';

export const SITE_NAME = 'The Homebrewery';

/** "<title> - The Homebrewery", or the site name alone for an empty title. */
export function pageTitle(title?: string | null): string {
  const trimmed = title?.trim();
  return trimmed ? `${trimmed} - ${SITE_NAME}` : SITE_NAME;
}

/** Sets document.title while the calling page is shown (screen readers announce it on navigation). */
export function usePageTitle(title?: string | null): void {
  const text = pageTitle(title);
  useEffect(() => {
    document.title = text;
  }, [text]);
}
