import clsx from 'clsx';
import type { ComponentPropsWithRef } from 'react';
import themeStyles from './theme.module.css';
import { type UiColorScheme, UiColorSchemeContext } from './uiContext';

export interface UiRootProps extends ComponentPropsWithRef<'div'> {
  /** 'system' (default) follows prefers-color-scheme. */
  colorScheme?: UiColorScheme;
  /** Also apply the base font, text color and background (default true). */
  surface?: boolean;
}

/**
 * Carries the design tokens (CSS custom properties) for everything inside it. Wrap app chrome in
 * one; portaled UI (dialogs, popovers, toasts) gets the tokens on its own container.
 */
export function UiRoot({ colorScheme = 'system', surface = true, className, children, ...rest }: UiRootProps) {
  return (
    <UiColorSchemeContext value={colorScheme}>
      <div
        {...rest}
        className={clsx(themeStyles.root, surface && themeStyles.surface, className)}
        data-color-scheme={colorScheme === 'system' ? undefined : colorScheme}
      >
        {children}
      </div>
    </UiColorSchemeContext>
  );
}
