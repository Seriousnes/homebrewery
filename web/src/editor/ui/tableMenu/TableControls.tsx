// The table controls (T3; the plugin is tables/controls.ts): a small toolbar under the table that
// holds the selection, rendered outside the canvas (a portal layer) so the table's DOM stays what
// the theme CSS expects. It follows the table through scrolling, zoom and pagination, and is
// hidden while the table is scrolled out. Pointer presses keep the editor's focus and selection;
// Shift+Alt+F10 moves the focus here, Escape and Tab return it to the text.
import type { Command } from '@tiptap/pm/state';
import { useLayoutEffect, useRef, useSyncExternalStore, type FocusEvent, type KeyboardEvent } from 'react';
import { Button, IconButton, MenuButton, Portal, Toolbar, ToolbarGroup, ToolbarSeparator, type MenuEntry } from '@/ui';
import { setHeaderRows, TABLE_CLASS_LABELS, tableContext, toggleTableClass, resetColumnWidths } from '../../tables/commands';
import type { TableControlsController } from '../../tables/controls';
import { ColumnWidthDialog } from './ColumnWidthDialog';
import { placeTableControls, type Box } from './controlsPlacement';
import styles from './tableControls.module.css';
import { tableMenuContext, type TableMenuContext } from './tableMenuContext';
import { DELETE_TABLE_ACTION, runTableCommand, TABLE_CELL_ACTIONS, TABLE_COLUMN_ACTIONS, TABLE_ROW_ACTIONS, type TableAction } from './tableMenuEntries';

export interface TableControlsProps {
  controller: TableControlsController;
}

/** The nearest scrolling ancestor (the canvas viewport), or null for the window. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  const win = el.ownerDocument.defaultView ?? window;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = win.getComputedStyle(p);
    if (overflowY === 'auto' || overflowY === 'scroll') return p;
  }
  return null;
}

function visibleBox(scroller: HTMLElement | null, win: Window): Box {
  const view = { top: 0, left: 0, bottom: win.innerHeight, right: win.innerWidth };
  if (!scroller) return view;
  const r = scroller.getBoundingClientRect();
  return { top: Math.max(view.top, r.top), left: Math.max(view.left, r.left), bottom: Math.min(view.bottom, r.bottom), right: Math.min(view.right, r.right) };
}

export function TableControls({ controller }: TableControlsProps) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, controller.store.getSnapshot);
  const { editor } = controller;
  const panelRef = useRef<HTMLDivElement>(null);
  const table = state.visible && !editor.isDestroyed ? state.table : null;

  // Place the controls under the table, and again whenever it may have moved: scrolling, window
  // resizes, the table's size, zoom (the scaled canvas's size), and every editor update (version).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const element = table?.element;
    if (!panel || !element) return;
    const win = panel.ownerDocument.defaultView ?? window;
    const scroller = scrollParent(element);
    let frame = 0;
    const place = () => {
      frame = 0;
      if (!element.isConnected) {
        panel.style.visibility = 'hidden';
        return;
      }
      const at = placeTableControls(element.getBoundingClientRect(), visibleBox(scroller, win), { width: panel.offsetWidth, height: panel.offsetHeight });
      panel.style.top = `${Math.round(at.top)}px`;
      panel.style.left = `${Math.round(at.left)}px`;
      panel.style.visibility = at.hidden ? 'hidden' : '';
    };
    const schedule = () => {
      if (!frame) frame = win.requestAnimationFrame(place);
    };
    place();
    win.addEventListener('scroll', schedule, true);
    win.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    observer?.observe(panel);
    const scaled = scroller?.firstElementChild;
    if (scaled) observer?.observe(scaled);
    return () => {
      if (frame) win.cancelAnimationFrame(frame);
      win.removeEventListener('scroll', schedule, true);
      win.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [table, state.version]);

  // Shift+Alt+F10: focus the controls' current item (also a request made before the first mount).
  const lastFocusRequest = useRef(0);
  useLayoutEffect(() => {
    if (state.focusRequest === lastFocusRequest.current) return;
    lastFocusRequest.current = state.focusRequest;
    panelRef.current?.querySelector<HTMLElement>('[role="toolbar"] [tabindex="0"]:not(:disabled), [role="toolbar"] button:not(:disabled)')?.focus();
  }, [state.focusRequest, table]);

  const dialog = <ColumnWidthDialog editor={editor} initial={state.columnWidth} onClose={() => controller.closeColumnWidthDialog()} />;
  if (!table) return dialog;
  const ctx = tableMenuContext(editor.state);
  if (!ctx.inTable) return dialog;

  const act = (command: Command) => {
    runTableCommand(editor, command);
    // The table is gone: back to the text (the caret is where it was).
    if (!tableContext(editor.state)) {
      controller.returnFocus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys of a menu (its list is a portal, but React events bubble here) are the menu's.
    if (event.defaultPrevented || !panelRef.current?.contains(event.target as Node)) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      controller.returnFocus();
    }
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) controller.setFocused(false);
  };

  const button = (action: TableAction) => (
    <IconButton
      key={action.id}
      icon={action.icon}
      label={action.label}
      size="sm"
      // aria-disabled, not disabled: the item keeps the focus (and its place in the toolbar) when it stops applying.
      aria-disabled={!ctx.can[action.can]}
      onClick={() => act(action.command)}
      data-testid={`table-${action.id}`}
    />
  );

  return (
    <>
      <Portal>
        <div
          ref={panelRef}
          className={styles.panel}
          data-testid="table-controls"
          // Pointer presses keep the editor's focus and selection.
          onMouseDown={(event) => event.preventDefault()}
          onFocus={() => controller.setFocused(true)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
        >
          <Toolbar label="Table" className={styles.toolbar}>
            <span className={styles.label} title="Shift+Alt+F10 moves the focus here; Escape returns to the text">
              Table
            </span>
            <ToolbarGroup label="Rows" className={styles.group}>
              {TABLE_ROW_ACTIONS.map(button)}
            </ToolbarGroup>
            <ToolbarSeparator />
            <ToolbarGroup label="Columns" className={styles.group}>
              {TABLE_COLUMN_ACTIONS.map(button)}
            </ToolbarGroup>
            <ToolbarSeparator />
            <ToolbarGroup label="Cells" className={styles.group}>
              {TABLE_CELL_ACTIONS.map(button)}
            </ToolbarGroup>
            <ToolbarSeparator />
            <ToolbarGroup label="Style" className={styles.group}>
              <Button size="sm" variant="ghost" className={styles.toggle} pressed={ctx.headerRow} onClick={() => act(setHeaderRows(!ctx.headerRow))} data-testid="table-header-row">
                Header row
              </Button>
              <Button size="sm" variant="ghost" className={styles.toggle} pressed={ctx.classes.wide} onClick={() => act(toggleTableClass('wide'))} data-testid="table-wide">
                Wide
              </Button>
              <MenuButton
                label="More"
                menuLabel="Table options"
                size="sm"
                variant="ghost"
                className={styles.toggle}
                items={optionEntries(ctx, act, () => controller.openColumnWidthDialog(), () => controller.afterMenuAction())}
                onOpenChange={(open) => controller.setMenuOpen(open)}
                data-testid="table-more"
              />
            </ToolbarGroup>
            <ToolbarSeparator />
            {button(DELETE_TABLE_ACTION)}
          </Toolbar>
        </div>
      </Portal>
      {dialog}
    </>
  );
}

/** The "More" menu: the class table styles and column widths. */
function optionEntries(ctx: TableMenuContext, act: (command: Command) => void, openColumnWidth: () => void, after: () => void): MenuEntry[] {
  return [
    {
      type: 'group',
      id: 'style',
      label: 'Table style',
      items: (['classTable', 'frame', 'decoration'] as const).map((cls) => ({
        id: `class-${cls}`,
        type: 'checkbox' as const,
        label: TABLE_CLASS_LABELS[cls],
        checked: ctx.classes[cls],
        onCheckedChange: () => {
          act(toggleTableClass(cls));
          after();
        },
      })),
    },
    {
      type: 'group',
      id: 'widths',
      label: 'Column widths',
      items: [
        { id: 'col-width', label: ctx.columnWidth ? `Column width (${ctx.columnWidth}px)…` : 'Column width…', onSelect: openColumnWidth },
        {
          id: 'col-reset',
          label: 'Automatic column widths',
          disabled: !ctx.can.resetColumnWidths,
          onSelect: () => {
            act(resetColumnWidths);
            after();
          },
        },
      ],
    },
  ];
}
