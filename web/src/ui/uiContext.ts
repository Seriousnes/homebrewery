import { createContext } from 'react';

/** 'system' follows prefers-color-scheme. */
export type UiColorScheme = 'system' | 'light' | 'dark';

/** The color scheme of the nearest UiRoot; portals copy it onto their containers. */
export const UiColorSchemeContext = createContext<UiColorScheme>('system');
