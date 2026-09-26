import clsx from 'clsx';
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button, type ButtonProps } from './Button';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import type { IconName } from './iconPaths';
import { focusElement } from './internal/focus';
import { flattenMenuItems, menuItemRole, nextEnabled } from './internal/menuModel';
import type { Placement } from './internal/position';
import { createTypeahead, findTypeaheadMatch, isTypeaheadKey } from './internal/typeahead';
import { useControllableState } from './internal/useControllableState';
import { type DismissReason, useDismiss } from './internal/useDismiss';
import { useFloating } from './internal/useFloating';
import styles from './Menu.module.css';
import type { MenuEntry, MenuItem, MenuLeaf } from './menuTypes';
import { Portal } from './Portal';

/** Props to spread on the element that opens the menu. */
export interface MenuTriggerProps {
  ref: (element: HTMLElement | null) => void;
  id: string;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface MenuProps {
  items: readonly MenuEntry[];
  /** Render the trigger (a button) with these props spread on it. */
  trigger: (props: MenuTriggerProps) => ReactElement;
  /** The menu's name; default: labelled by the trigger. */
  label?: string;
  /** Default 'bottom-start'. */
  placement?: Placement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  'data-testid'?: string;
}

type Focus = 'first' | 'last';

/**
 * Menu button (WAI-ARIA APG): Enter, Space or ArrowDown open it on the first item, ArrowUp on the
 * last; in the menu ArrowUp/Down move (wrapping), Home/End jump, typing a letter jumps to the next
 * item starting with it, Enter/Space activate, Escape or Tab close it and focus the trigger.
 */
export function Menu({ items, trigger, label, placement = 'bottom-start', open: openProp, onOpenChange, className, 'data-testid': testId }: MenuProps) {
  const [open, setOpen] = useControllableState(openProp, false, onOpenChange);
  const [initialFocus, setInitialFocus] = useState<Focus>('first');
  // The trigger element lives in state (set by its ref callback), not a ref: it is handed to a
  // render function and to the menu list.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const triggerId = useId();
  const menuId = useId();

  const openWith = (focus: Focus) => {
    setInitialFocus(focus);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) focusElement(anchor);
  };

  const triggerProps: MenuTriggerProps = {
    ref: setAnchor,
    id: triggerId,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => (open ? close(false) : openWith('first')),
    onKeyDown: (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openWith(event.key === 'ArrowDown' ? 'first' : 'last');
      }
    },
  };

  return (
    <>
      {trigger(triggerProps)}
      {open ? (
        <MenuList
          id={menuId}
          items={items}
          anchor={anchor}
          labelledBy={label ? undefined : triggerId}
          label={label}
          placement={placement}
          initialFocus={initialFocus}
          onClose={close}
          className={className}
          testId={testId}
        />
      ) : null}
    </>
  );
}

interface MenuListProps {
  id: string;
  items: readonly MenuEntry[];
  anchor: HTMLElement | null;
  labelledBy: string | undefined;
  label: string | undefined;
  placement: Placement;
  initialFocus: Focus;
  onClose: (refocus: boolean) => void;
  className: string | undefined;
  testId: string | undefined;
}

function MenuList({ id, items, anchor, labelledBy, label, placement, initialFocus, onClose, className, testId }: MenuListProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const typeahead = useRef(createTypeahead());
  const flat = flattenMenuItems(items);
  // When any item can be checked, every item gets the check column so labels line up.
  const checkColumn = flat.some((item) => item.type === 'checkbox' || item.type === 'radio');
  const [active, setActive] = useState(() =>
    initialFocus === 'last' ? nextEnabled(flat, 0, -1) : nextEnabled(flat, -1, 1),
  );

  useFloating(true, anchor, menuRef, { placement, offset: 4 });
  useDismiss(true, {
    floatingRef: menuRef,
    anchorRef: anchor,
    focusOut: true,
    onDismiss: (reason: DismissReason) => onClose(reason === 'escape'),
  });

  const focusItem = (index: number) => {
    if (index < 0) return;
    setActive(index);
    focusElement(itemRefs.current[index], { preventScroll: false });
  };

  const registerItem = (index: number, el: HTMLDivElement | null) => {
    itemRefs.current[index] = el;
  };

  // The initial active item is chosen in state; this only moves focus there.
  const focusInitial = useEffectEvent(() => {
    if (!focusElement(itemRefs.current[active], { preventScroll: false })) focusElement(menuRef.current);
  });
  useLayoutEffect(() => {
    focusInitial();
  }, []);

  const activate = (index: number) => {
    const item = flat[index];
    if (!item || item.disabled) return;
    const closeAfter = item.closeOnSelect !== false;
    if (closeAfter) onClose(true);
    if (item.type === 'checkbox') item.onCheckedChange(!item.checked);
    else item.onSelect();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu || !menu.contains(event.target as Node)) return;
    const current = itemRefs.current.findIndex((el) => el === event.target);
    const from = current >= 0 ? current : active;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(nextEnabled(flat, from, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(nextEnabled(flat, from < 0 ? 0 : from, -1));
        return;
      case 'Home':
        event.preventDefault();
        focusItem(nextEnabled(flat, -1, 1));
        return;
      case 'End':
        event.preventDefault();
        focusItem(nextEnabled(flat, 0, -1));
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (from >= 0) activate(from);
        return;
      case 'Tab':
        event.preventDefault();
        onClose(true);
        return;
      default:
        if (isTypeaheadKey(event)) {
          event.preventDefault();
          const search = typeahead.current.push(event.key);
          const match = findTypeaheadMatch(
            flat.map((item) => item.label),
            search,
            from,
            (i) => Boolean(flat[i]?.disabled),
          );
          if (match >= 0) focusItem(match);
        }
    }
  };

  const renderLeaf = (entry: MenuLeaf, key: string) => {
    if (entry.type === 'separator') return <div key={key} role="separator" className={styles.separator} />;
    const i = flat.indexOf(entry);
    return <MenuItemView key={key} item={entry} index={i} active={i === active} checkColumn={checkColumn} registerItem={registerItem} onActivate={activate} onHover={focusItem} />;
  };

  return (
    <Portal>
      <div
        ref={menuRef}
        id={id}
        role="menu"
        aria-labelledby={labelledBy}
        aria-label={label}
        aria-orientation="vertical"
        tabIndex={-1}
        className={clsx(styles.menu, className)}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        {items.map((entry, i) => {
          const key = entry.id ?? `separator-${i}`;
          if (entry.type !== 'group') return renderLeaf(entry, key);
          return (
            <Fragment key={key}>
              <div role="group" aria-labelledby={`${id}-${entry.id}`} className={styles.group}>
                <div id={`${id}-${entry.id}`} role="presentation" className={styles.groupLabel}>
                  {entry.label}
                </div>
                {entry.items.map((child, j) => renderLeaf(child, child.id ?? `${key}-separator-${j}`))}
              </div>
            </Fragment>
          );
        })}
      </div>
    </Portal>
  );
}

interface MenuItemViewProps {
  item: MenuItem;
  index: number;
  active: boolean;
  checkColumn: boolean;
  registerItem: (index: number, el: HTMLDivElement | null) => void;
  onActivate: (index: number) => void;
  onHover: (index: number) => void;
}

function MenuItemView({ item, index, active, checkColumn, registerItem, onActivate, onHover }: MenuItemViewProps) {
  const checkable = item.type === 'checkbox' || item.type === 'radio';
  return (
    <div
      ref={(el) => registerItem(index, el)}
      role={menuItemRole(item)}
      aria-checked={checkable ? item.checked : undefined}
      aria-disabled={item.disabled || undefined}
      tabIndex={active ? 0 : -1}
      className={styles.item}
      data-menu-item={item.id}
      onClick={() => onActivate(index)}
      onPointerMove={() => {
        if (!item.disabled && !active) onHover(index);
      }}
    >
      {checkColumn ? (
        <span className={styles.check} aria-hidden="true">
          {checkable && item.checked ? <Icon name="check" size={14} /> : null}
        </span>
      ) : null}
      {item.icon ? <Icon name={item.icon} size={16} /> : null}
      <span className={styles.label}>{item.label}</span>
      {item.shortcut ? <span className={styles.shortcut}>{item.shortcut}</span> : null}
    </div>
  );
}

export interface MenuButtonProps extends Omit<ButtonProps, 'onClick' | 'onKeyDown' | 'children' | 'icon' | 'ref' | 'id'> {
  /** The button text, or its aria-label when iconOnly. */
  label: string;
  items: readonly MenuEntry[];
  icon?: IconName;
  /** Show only the icon (label becomes aria-label and tooltip). Needs `icon`. */
  iconOnly?: boolean;
  placement?: Placement;
  /** The menu's own name when it differs from the button's. */
  menuLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  menuClassName?: string;
  'data-testid'?: string;
}

/** A Button (or IconButton) that opens a Menu. */
export function MenuButton({
  label,
  items,
  icon,
  iconOnly = false,
  placement,
  menuLabel,
  open,
  onOpenChange,
  menuClassName,
  variant,
  'data-testid': testId,
  ...buttonProps
}: MenuButtonProps) {
  return (
    <Menu
      items={items}
      label={menuLabel}
      placement={placement}
      open={open}
      onOpenChange={onOpenChange}
      className={menuClassName}
      data-testid={testId ? `${testId}-menu` : undefined}
      trigger={(props) =>
        iconOnly && icon ? (
          <IconButton {...buttonProps} {...props} variant={variant} icon={icon} label={label} data-testid={testId} />
        ) : (
          <Button {...buttonProps} {...props} variant={variant} icon={icon} iconEnd="chevronDown" data-testid={testId}>
            {label}
          </Button>
        )
      }
    />
  );
}
