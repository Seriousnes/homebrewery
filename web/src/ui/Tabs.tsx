import clsx from 'clsx';
import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';
import { focusElement } from './internal/focus';
import { useControllableState } from './internal/useControllableState';
import styles from './Tabs.module.css';

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  /** Selected tab id (controlled). */
  value?: string;
  /** Initially selected tab id (uncontrolled; default: the first enabled tab). */
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  /** The tab list's accessible name. */
  label: string;
  orientation?: 'horizontal' | 'vertical';
  /** 'automatic' (default) selects on arrow keys; 'manual' moves focus only, Enter/Space select. */
  activation?: 'automatic' | 'manual';
  /** Keep inactive panels mounted (hidden) to preserve their state. */
  keepMounted?: boolean;
  className?: string;
  'data-testid'?: string;
}

/** Tabs (WAI-ARIA APG): one tab stop, arrow keys move between tabs, Home/End jump. */
export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  label,
  orientation = 'horizontal',
  activation = 'automatic',
  keepMounted = false,
  className,
  'data-testid': testId,
}: TabsProps) {
  const firstEnabled = items.find((item) => !item.disabled)?.id ?? '';
  const [selectedRaw, setSelected] = useControllableState(value, defaultValue ?? firstEnabled, onValueChange);
  const selected = items.some((item) => item.id === selectedRaw && !item.disabled) ? selectedRaw : firstEnabled;
  const baseId = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((item) => !item.disabled);
    const current = enabled.findIndex((item) => tabRefs.current.get(item.id) === event.target);
    if (current < 0) return;
    const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    let target: number;
    if (event.key === next) target = (current + 1) % enabled.length;
    else if (event.key === prev) target = (current - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = enabled.length - 1;
    else return;
    event.preventDefault();
    const item = enabled[target];
    if (!item) return;
    focusElement(tabRefs.current.get(item.id), { preventScroll: false });
    if (activation === 'automatic') setSelected(item.id);
  };

  return (
    <div className={clsx(styles.tabs, orientation === 'vertical' && styles.vertical, className)} data-testid={testId}>
      <div role="tablist" aria-label={label} aria-orientation={orientation} className={styles.list} onKeyDown={onKeyDown}>
        {items.map((item) => {
          const isSelected = item.id === selected;
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el) tabRefs.current.set(item.id, el);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={tabId(item.id)}
              aria-selected={isSelected}
              aria-controls={panelId(item.id)}
              tabIndex={isSelected ? 0 : -1}
              disabled={item.disabled}
              className={styles.tab}
              onClick={() => setSelected(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => {
        const isSelected = item.id === selected;
        if (!isSelected && !keepMounted) return null;
        return (
          <div
            key={item.id}
            role="tabpanel"
            id={panelId(item.id)}
            aria-labelledby={tabId(item.id)}
            tabIndex={0}
            hidden={!isSelected}
            className={styles.panel}
          >
            {item.content}
          </div>
        );
      })}
    </div>
  );
}
