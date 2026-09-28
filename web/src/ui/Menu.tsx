import clsx from 'clsx';
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
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
import { useFloating, type VirtualAnchor } from './internal/useFloating';
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

/** Where a menu opens its focus: the first or last item, or none (a submenu opened by hovering). */
type Focus = 'first' | 'last' | 'none';

/**
 * Why a menu list closed. 'select', 'escape' and 'tab' return the focus to what opened it;
 * 'back' (ArrowLeft in a submenu) to its parent item; 'outside' and 'focus-out' leave it where
 * the pointer or the focus went.
 */
type CloseReason = 'select' | 'escape' | 'tab' | 'back' | DismissReason;

const returnsFocus = (reason: CloseReason) => reason !== 'outside' && reason !== 'focus-out';

/**
 * Menu button (WAI-ARIA APG): Enter, Space or ArrowDown open it on the first item, ArrowUp on the
 * last; in the menu ArrowUp/Down move (wrapping), Home/End jump, typing a letter jumps to the next
 * item starting with it, Enter/Space activate, Escape or Tab close it and focus the trigger. A
 * submenu item opens its menu with ArrowRight, Enter, Space, a click or the pointer resting on it;
 * ArrowLeft or Escape closes the submenu and focuses its item again.
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
  const close = (reason: CloseReason) => {
    setOpen(false);
    if (returnsFocus(reason)) focusElement(anchor);
  };

  const triggerProps: MenuTriggerProps = {
    ref: setAnchor,
    id: triggerId,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => (open ? close('outside') : openWith('first')),
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

export interface ContextMenuProps {
  items: readonly MenuEntry[];
  /** Where it opens, in viewport coordinates (a contextmenu event's clientX / clientY). */
  point: { x: number; y: number };
  /** The menu's name. */
  label: string;
  /**
   * The menu closed. `returnFocus`: an item was picked, or Escape or Tab closed it, so put the
   * focus back where the menu was opened; false after a click or focus elsewhere.
   */
  onClose: (returnFocus: boolean) => void;
  /** A hint under the items (e.g. how to reach the browser's own menu); the menu's description. */
  footer?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

/**
 * A menu at a point (a right-click menu), open while rendered: focus on its first item, keys as in
 * Menu. Right-clicks inside it don't open the browser's menu.
 */
export function ContextMenu({ items, point, label, onClose, footer, className, 'data-testid': testId }: ContextMenuProps) {
  const id = useId();
  const anchor = useMemo<VirtualAnchor>(() => ({ getBoundingClientRect: () => ({ top: point.y, left: point.x, width: 0, height: 0 }) }), [point.x, point.y]);
  return (
    <MenuList
      id={id}
      items={items}
      anchor={anchor}
      labelledBy={undefined}
      label={label}
      placement="bottom-start"
      offset={0}
      initialFocus="first"
      onClose={(reason) => onClose(returnsFocus(reason))}
      footer={footer}
      className={className}
      testId={testId}
    />
  );
}

interface MenuListProps {
  id: string;
  items: readonly MenuEntry[];
  anchor: HTMLElement | VirtualAnchor | null;
  labelledBy: string | undefined;
  label: string | undefined;
  placement: Placement;
  offset?: number;
  initialFocus: Focus;
  onClose: (reason: CloseReason) => void;
  footer?: ReactNode;
  /** A submenu: Escape and ArrowLeft go back to its item. */
  nested?: boolean;
  className: string | undefined;
  testId: string | undefined;
}

interface OpenSubmenu {
  index: number;
  /** Its item's element (the submenu's anchor). */
  anchor: HTMLElement | null;
  focus: Focus;
  /** A new key remounts the submenu (to move the focus into one opened by hovering). */
  key: number;
}

function MenuList({ id, items, anchor, labelledBy, label, placement, offset = 4, initialFocus, onClose, footer, nested = false, className, testId }: MenuListProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const typeahead = useRef(createTypeahead());
  const flat = flattenMenuItems(items);
  // When any item can be checked, every item gets the check column so labels line up.
  const checkColumn = flat.some((item) => item.type === 'checkbox' || item.type === 'radio');
  const [active, setActive] = useState(() =>
    initialFocus === 'none' ? -1 : initialFocus === 'last' ? nextEnabled(flat, 0, -1) : nextEnabled(flat, -1, 1),
  );
  const [submenu, setSubmenu] = useState<OpenSubmenu | null>(null);
  const footerId = `${id}-footer`;

  useFloating(true, anchor, menuRef, { placement, offset });
  useDismiss(true, {
    floatingRef: menuRef,
    anchorRef: anchor instanceof HTMLElement ? anchor : undefined,
    focusOut: true,
    onDismiss: (reason: DismissReason) => onClose(reason === 'escape' && nested ? 'back' : reason),
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
    if (initialFocus === 'none') return;
    if (!focusElement(itemRefs.current[active], { preventScroll: false })) focusElement(menuRef.current);
  });
  useLayoutEffect(() => {
    focusInitial();
  }, []);

  // The open submenu, also as a ref: a submenu that was replaced (a new key) can still report a
  // focus-out before its listeners are removed; that must not close its successor.
  const submenuRef = useRef(submenu);
  const nextKey = useRef(0);
  const setOpenSubmenu = (next: OpenSubmenu | null) => {
    submenuRef.current = next;
    setSubmenu(next);
  };

  const openSubmenu = (index: number, focus: Focus) => {
    const open = submenuRef.current;
    if (open?.index === index && (focus === 'none' || open.focus === focus)) return;
    setOpenSubmenu({ index, anchor: itemRefs.current[index] ?? null, focus, key: ++nextKey.current });
  };

  const onSubmenuClose = (key: number, reason: CloseReason) => {
    const current = submenuRef.current;
    if (!current || current.key !== key) return;
    const index = current.index;
    setOpenSubmenu(null);
    if (reason === 'select' || reason === 'tab') onClose(reason);
    else if (reason === 'back' || reason === 'escape') focusItem(index);
  };

  const activate = (index: number) => {
    const item = flat[index];
    if (!item || item.disabled) return;
    if (item.type === 'submenu') {
      openSubmenu(index, 'first');
      return;
    }
    const closeAfter = item.closeOnSelect !== false;
    if (closeAfter) onClose('select');
    if (item.type === 'checkbox') item.onCheckedChange(!item.checked);
    else item.onSelect();
  };

  const hover = (index: number) => {
    const item = flat[index];
    if (!item || item.disabled) return;
    if (index !== active) focusItem(index);
    if (item.type === 'submenu') openSubmenu(index, 'none');
    else if (submenuRef.current) setOpenSubmenu(null);
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
      case 'ArrowRight':
        if (from >= 0 && flat[from]?.type === 'submenu') {
          event.preventDefault();
          activate(from);
        }
        return;
      case 'ArrowLeft':
        if (nested) {
          event.preventDefault();
          onClose('back');
        }
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
        onClose('tab');
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

  const itemId = (i: number) => `${id}-item-${i}`;

  const renderLeaf = (entry: MenuLeaf, key: string) => {
    if (entry.type === 'separator') return <div key={key} role="separator" className={styles.separator} />;
    const i = flat.indexOf(entry);
    return (
      <MenuItemView
        key={key}
        id={itemId(i)}
        item={entry}
        index={i}
        active={i === active}
        expanded={submenu?.index === i}
        controls={submenu?.index === i ? `${id}-submenu` : undefined}
        checkColumn={checkColumn}
        registerItem={registerItem}
        onActivate={activate}
        onHover={hover}
      />
    );
  };

  const open = submenu ? flat[submenu.index] : undefined;

  return (
    <Portal>
      <div
        ref={menuRef}
        id={id}
        role="menu"
        aria-labelledby={labelledBy}
        aria-label={label}
        aria-describedby={footer ? footerId : undefined}
        aria-orientation="vertical"
        tabIndex={-1}
        className={clsx(styles.menu, className)}
        data-testid={testId}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => event.preventDefault()}
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
        {footer ? (
          <div id={footerId} role="presentation" className={styles.footer}>
            {footer}
          </div>
        ) : null}
      </div>
      {submenu && open?.type === 'submenu' ? (
        <MenuList
          key={submenu.key}
          id={`${id}-submenu`}
          items={open.items}
          anchor={submenu.anchor}
          labelledBy={itemId(submenu.index)}
          label={undefined}
          placement="right-start"
          offset={0}
          initialFocus={submenu.focus}
          onClose={(reason) => onSubmenuClose(submenu.key, reason)}
          nested
          className={className}
          testId={testId ? `${testId}-${open.id}` : undefined}
        />
      ) : null}
    </Portal>
  );
}

interface MenuItemViewProps {
  id: string;
  item: MenuItem;
  index: number;
  active: boolean;
  /** A submenu item whose menu is open. */
  expanded: boolean;
  controls: string | undefined;
  checkColumn: boolean;
  registerItem: (index: number, el: HTMLDivElement | null) => void;
  onActivate: (index: number) => void;
  onHover: (index: number) => void;
}

function MenuItemView({ id, item, index, active, expanded, controls, checkColumn, registerItem, onActivate, onHover }: MenuItemViewProps) {
  const checkable = item.type === 'checkbox' || item.type === 'radio';
  const submenu = item.type === 'submenu';
  return (
    <div
      ref={(el) => registerItem(index, el)}
      id={id}
      role={menuItemRole(item)}
      aria-checked={checkable ? item.checked : undefined}
      aria-disabled={item.disabled || undefined}
      aria-label={item.content != null ? item.label : undefined}
      aria-haspopup={submenu ? 'menu' : undefined}
      aria-expanded={submenu ? expanded : undefined}
      aria-controls={controls}
      tabIndex={active ? 0 : -1}
      className={styles.item}
      data-menu-item={item.id}
      onClick={() => onActivate(index)}
      onPointerMove={() => {
        if (!item.disabled && (!active || (submenu && !expanded))) onHover(index);
      }}
    >
      {checkColumn ? (
        <span className={styles.check} aria-hidden="true">
          {checkable && item.checked ? <Icon name="check" size={14} /> : null}
        </span>
      ) : null}
      {item.icon ? <Icon name={item.icon} size={16} /> : null}
      {item.content != null ? <div className={styles.label}>{item.content}</div> : <span className={styles.label}>{item.label}</span>}
      {!submenu && item.shortcut ? <span className={styles.shortcut}>{item.shortcut}</span> : null}
      {submenu ? <Icon name="chevronRight" size={14} className={styles.submenuArrow} /> : null}
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
