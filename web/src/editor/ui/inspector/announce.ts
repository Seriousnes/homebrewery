import { createContext, use } from 'react';

/**
 * Speaks a message in the Inspector's polite live region. Fields call it when an edit is refused,
 * because an error that appears after a blur (the field's aria-describedby) is not read out.
 */
export const AnnounceContext = createContext<(message: string) => void>(() => {});

export function useAnnounce(): (message: string) => void {
  return use(AnnounceContext);
}
