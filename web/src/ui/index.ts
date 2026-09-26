// The UI kit (app chrome only; plan §5: CSS modules, tokens on .root, no global selectors).
// Import from '@/ui'.
export { UiRoot, type UiRootProps } from './UiRoot';
export { type UiColorScheme, UiColorSchemeContext } from './uiContext';
export { default as uiThemeStyles } from './theme.module.css';
export { Portal, type PortalProps } from './Portal';
export { VisuallyHidden, type VisuallyHiddenProps } from './VisuallyHidden';
export { Icon, type IconProps } from './Icon';
export { ICON_NAMES, ICONS, type IconDef, type IconName } from './iconPaths';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { Spinner, type SpinnerProps } from './Spinner';
export { Tooltip, type TooltipProps } from './Tooltip';
export { Dialog, type DialogProps, type DialogSize } from './Dialog';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
export { Popover, type PopoverProps } from './Popover';
export { Menu, MenuButton, type MenuButtonProps, type MenuProps, type MenuTriggerProps } from './Menu';
export type {
  MenuActionItem,
  MenuCheckboxItem,
  MenuEntry,
  MenuGroup,
  MenuItem,
  MenuLeaf,
  MenuRadioItem,
  MenuSeparator,
} from './menuTypes';
export { Toaster, type ToasterProps } from './Toaster';
export {
  clearToasts,
  DEFAULT_TOAST_DURATION_MS,
  dismissToast,
  ERROR_TOAST_DURATION_MS,
  MAX_TOASTS,
  toast,
  toastStore,
  useToasts,
  type Toast,
  type ToastAction,
  type ToastInput,
  type ToastState,
  type ToastTone,
} from './toastStore';
export { Tabs, type TabItem, type TabsProps } from './Tabs';
export { TextArea, TextField, type FieldProps, type TextAreaProps, type TextFieldProps } from './TextField';
export { Select, type SelectOption, type SelectProps } from './Select';
export { Checkbox, Switch, type CheckboxProps, type SwitchProps } from './Checkbox';
export { Toolbar, ToolbarGroup, ToolbarSeparator, type ToolbarGroupProps, type ToolbarProps } from './Toolbar';
export {
  Drawer,
  ResizeHandle,
  SplitMain,
  SplitPanel,
  type DrawerProps,
  type DrawerSide,
  type ResizeHandleProps,
  type SplitPanelProps,
} from './SplitPanel';
export type { Placement } from './internal/position';
export type { DismissReason } from './internal/useDismiss';
// Helpers for components built outside the kit (the canvas lanes' own popovers and toolbars).
export { computePosition, type PositionInput, type PositionResult } from './internal/position';
export { useFloating, type FloatingOptions } from './internal/useFloating';
export { useDismiss, type DismissOptions } from './internal/useDismiss';
export { focusElement, focusFirst, getFocusables, getTabbables, trapTab } from './internal/focus';
export { getPortalRoot, pushModalLayer, registerEscape } from './internal/layers';
export { createTypeahead, findTypeaheadMatch, isTypeaheadKey } from './internal/typeahead';
export { moveRovingFocus, rovingItems, syncRovingTabIndex } from './internal/roving';
