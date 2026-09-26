import clsx from 'clsx';
import { type ReactNode, type Ref, use } from 'react';
import { createPortal } from 'react-dom';
import { getPortalRoot, LAYER_ATTR, type LayerKind } from './internal/layers';
import themeStyles from './theme.module.css';
import { UiColorSchemeContext } from './uiContext';

export interface PortalProps {
  children: ReactNode;
  /** 'toast' layers stay above (and interactive under) modal dialogs. */
  kind?: LayerKind;
  /** The layer element (the portal container). */
  layerRef?: Ref<HTMLDivElement>;
}

/**
 * Render into a new layer at the end of <body> (outside the editor canvas, whose viewport confines
 * position: fixed). The layer carries the design tokens and the nearest UiRoot's color scheme.
 */
export function Portal({ children, kind = 'layer', layerRef }: PortalProps) {
  const scheme = use(UiColorSchemeContext);
  return createPortal(
    <div
      ref={layerRef}
      className={clsx(themeStyles.root, kind === 'toast' ? themeStyles.toastLayer : themeStyles.layer)}
      {...{ [LAYER_ATTR]: kind }}
      data-color-scheme={scheme === 'system' ? undefined : scheme}
    >
      {children}
    </div>,
    getPortalRoot(),
  );
}
