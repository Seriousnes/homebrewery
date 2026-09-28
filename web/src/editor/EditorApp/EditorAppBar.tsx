// The composed editor's second toolbar (plan §6.2): panel toggles (outline, style, inspector),
// page navigation, the layout status (oversize warnings), print and the brew actions (source,
// properties, local history). In the read-only view it also carries zoom and page layout, which the editing
// toolbar has otherwise. One tab stop with roving focus, like every toolbar.
import type { Editor } from '@tiptap/core';
import type { ReactNode, RefObject } from 'react';
import { type PanelId, type Spread, uiStore, useUiStore, ZOOM_LEVELS } from '@/app/uiStore';
import { shortcutFor } from '@/editor/commands/keymap';
import { LayoutStatus } from '@/editor/ui/layoutStatus/LayoutStatus';
import { PageNav } from '@/editor/ui/pageNav/PageNav';
import type { PageTracker } from '@/editor/ui/pageNav/pageTracker';
import { openSourceEditor } from '@/editor/ui/sourceEditor/openSourceEditor';
import { Button, IconButton, type IconName, type MenuEntry, MenuButton, Toolbar, ToolbarGroup, ToolbarSeparator } from '@/ui';
import { type EditorAppMode, PANEL_ELEMENT_IDS } from './editorAppModel';
import styles from './EditorApp.module.css';

export interface EditorAppBarProps {
  mode: EditorAppMode;
  editor: Editor | null;
  tracker: PageTracker | null;
  /** Toggle buttons (the drawers return focus to them when they close). */
  toggleRefs: Readonly<Record<PanelId, RefObject<HTMLButtonElement | null>>>;
  /** The properties dialog (null: no dialog on this page). */
  onProperties?: (() => void) | null;
  /** The local history dialog (null: none). */
  onHistory?: (() => void) | null;
  propertiesRef?: RefObject<HTMLButtonElement | null>;
  /** Print the pages (the canvas print). */
  onPrint: () => void;
  /** Rendered right after Print: the "Download PDF" button (issue #2, editor/export/DownloadPdfButton). */
  exportAction?: ReactNode;
  /** A status note at the end of the bar (the read-only view: e.g. the share page's view count). */
  status?: ReactNode;
  /** More panel toggles, after the store's (the Snippets panel's). */
  panelToggles?: ReactNode;
}

const PANEL_TOGGLES: readonly { id: PanelId; icon: IconName; label: string; edit: boolean }[] = [
  { id: 'outline', icon: 'outline', label: 'Outline', edit: false },
  { id: 'style', icon: 'braces', label: 'Style (brew CSS)', edit: true },
];

const SPREAD_LABELS: Record<Spread, string> = { single: 'Single pages', facing: 'Facing pages', flow: 'Flowing pages' };
const SPREAD_ICONS: Record<Spread, IconName> = { single: 'spreadSingle', facing: 'spreadFacing', flow: 'spreadFlow' };
const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;

export function EditorAppBar({ mode, editor, tracker, toggleRefs, onProperties, onHistory, propertiesRef, onPrint, exportAction, status, panelToggles }: EditorAppBarProps) {
  const print = shortcutFor('print');
  const source = shortcutFor('editSource');
  const panels = useUiStore((s) => s.panels);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const editable = mode === 'edit';
  // The source dialog (T5, editor/ui/sourceEditor): EditorApp mounts its host while editing.
  const showSource = editable && editor !== null;

  const toggle = (id: PanelId, icon: IconName, label: string) => {
    const open = panels[id].open;
    return (
      <IconButton
        key={id}
        ref={toggleRefs[id]}
        icon={icon}
        label={label}
        tooltip="bottom"
        pressed={open}
        aria-expanded={open}
        aria-controls={open ? PANEL_ELEMENT_IDS[id] : undefined}
        onClick={() => togglePanel(id)}
        data-testid={`toggle-${id}`}
      />
    );
  };

  return (
    <Toolbar label={editable ? 'Brew' : 'Viewing'} tone="view" className={styles.bar} data-testid="editor-app-bar">
      <ToolbarGroup label="Panels">
        {PANEL_TOGGLES.filter((t) => editable || !t.edit).map((t) => toggle(t.id, t.icon, t.label))}
        {panelToggles}
      </ToolbarGroup>
      <ToolbarSeparator />
      <PageNav tracker={tracker} />
      {editable ? null : (
        <>
          <ToolbarSeparator />
          <ViewControls />
        </>
      )}
      <div className={styles.barEnd}>
        {editable ? <LayoutStatus editor={editor} /> : status}
        <IconButton icon="print" label="Print" tooltip="bottom" shortcut={print.label} aria-keyshortcuts={print.aria} onClick={onPrint} data-testid="print" />
        {exportAction}
        {onHistory || onProperties || showSource ? (
          <ToolbarGroup label="Brew">
            {showSource ? (
              <Button
                size="sm"
                variant="ghost"
                icon="code"
                aria-haspopup="dialog"
                aria-keyshortcuts={source.aria}
                title={`Edit the HTML source (${source.label})`}
                onClick={() => openSourceEditor(editor)}
                data-testid="open-source"
              >
                Source
              </Button>
            ) : null}
            {onHistory ? (
              <Button size="sm" variant="ghost" icon="undo" aria-haspopup="dialog" onClick={onHistory} data-testid="open-local-history">
                Local history
              </Button>
            ) : null}
            {onProperties ? (
              <Button
                ref={propertiesRef}
                size="sm"
                variant="ghost"
                icon="settings"
                aria-haspopup="dialog"
                onClick={onProperties}
                data-testid="open-properties"
              >
                Properties
              </Button>
            ) : null}
          </ToolbarGroup>
        ) : null}
        {editable ? toggle('inspector', 'panelRight', 'Inspector') : null}
      </div>
    </Toolbar>
  );
}

/** Zoom and page layout (UI store) for the read-only view. */
function ViewControls() {
  const zoom = useUiStore((s) => s.zoom);
  const spread = useUiStore((s) => s.spread);
  const zoomItems: MenuEntry[] = ZOOM_LEVELS.map((level) => ({
    id: String(level),
    type: 'radio' as const,
    label: percent(level),
    checked: Math.abs(zoom - level) < 1e-6,
    onSelect: () => uiStore.getState().setZoom(level),
  }));
  const spreadItems: MenuEntry[] = (['single', 'facing', 'flow'] as const).map((id) => ({
    id,
    type: 'radio' as const,
    label: SPREAD_LABELS[id],
    icon: SPREAD_ICONS[id],
    checked: spread === id,
    onSelect: () => uiStore.getState().setSpread(id),
  }));
  return (
    <ToolbarGroup label="View">
      <IconButton icon="zoomOut" label="Zoom out" tooltip="bottom" disabled={zoom <= ZOOM_LEVELS[0]!} onClick={() => uiStore.getState().zoomOut()} data-testid="zoom-out" />
      <MenuButton label={percent(zoom)} aria-label={`Zoom: ${percent(zoom)}`} menuLabel="Zoom" items={zoomItems} variant="ghost" className={styles.zoom} data-testid="zoom-menu" />
      <IconButton
        icon="zoomIn"
        label="Zoom in"
        tooltip="bottom"
        disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!}
        onClick={() => uiStore.getState().zoomIn()}
        data-testid="zoom-in"
      />
      <MenuButton label={`Page layout: ${SPREAD_LABELS[spread]}`} icon={SPREAD_ICONS[spread]} iconOnly menuLabel="Page layout" items={spreadItems} data-testid="spread-menu" />
    </ToolbarGroup>
  );
}
