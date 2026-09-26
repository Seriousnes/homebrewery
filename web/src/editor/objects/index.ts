// Page objects (P5.3), images (plan §6.6) and the page commands of the cover-page workflow.
//
//   PageObjects          extension: object selection + ObjectLayer (frame, handles, toolbar)
//   ImageWithView        the image node with ImageView and natural-size capture (EditorCanvas
//                        includes it through editorNodeViews)
//   pageEditingExtensions  everything this lane adds to an editing canvas (below)
import type { AnyExtension } from '@tiptap/core';
import { IconSuggestion } from '../icons/extension';
import { DefinitionListKeys } from '../ui/blockMenu/definitionListKeys';
import { PageObjects } from './extension';

export * from './commands';
export * from './model';
export { imagePlacement, placementInPage } from './dom';
export { objectLayerOf, PageObjects } from './extension';
export { heightOnly, ImageView, ImageWithView, imageNaturalSizePlugin, NATURAL_ATTR, NATURAL_SIZE_META, NATURAL_WIDTH_VAR, naturalSizeTransaction } from './imageView';
export { PageAttrStep, setPageAttr } from './pageAttrStep';
export { applyObjectSelection, findObjectByPid, OBJECT_SELECTION, objectSelectionKey, pageNodeAt, selectedObject, type ObjectRef, type ObjectSelectionState } from './state';

/**
 * The editing extensions of P5.3/P5.5/P5.7 for an editable canvas: page objects, `:` icon
 * autocomplete and definition-list keys. (Image natural sizes and table header rows are part of
 * every canvas already: editorNodeViews.) Memoize the array you pass to EditorCanvas.
 */
export const pageEditingExtensions: AnyExtension[] = [PageObjects, IconSuggestion, DefinitionListKeys];
