import { type ReactNode, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { type Spread, uiStore, useUiStore } from '@/app/uiStore';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Drawer,
  Icon,
  ICON_NAMES,
  IconButton,
  type MenuEntry,
  MenuButton,
  Popover,
  Select,
  Spinner,
  SplitMain,
  SplitPanel,
  Switch,
  Tabs,
  TextArea,
  TextField,
  toast,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  Tooltip,
  type UiColorScheme,
  UiRoot,
  VisuallyHidden,
} from '@/ui';
import styles from './UiKitDevPage.module.css';

const SPREAD_LABELS: Record<Spread, string> = { single: 'Single page', facing: 'Facing pages', flow: 'Flow' };
const SPREAD_ICONS = { single: 'spreadSingle', facing: 'spreadFacing', flow: 'spreadFlow' } as const;
const BLOCK_LABELS: Record<string, string> = { paragraph: 'Paragraph', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3' };

/** /dev/ui-kit: every UI kit primitive, wired to the real UI store, for manual checks and e2e. */
export function UiKitDevPage() {
  const [scheme, setScheme] = useState<UiColorScheme>('system');
  const [last, setLast] = useState('none');
  const report = (what: string) => setLast(what);

  return (
    <UiRoot colorScheme={scheme} className={styles.page}>
      <VisuallyHidden focusable>
        <a href="#ui-kit-main" className={styles.skip} data-testid="skip-link">
          Skip to the primitives
        </a>
      </VisuallyHidden>
      <header className={styles.header}>
        <h1 className={styles.title}>UI kit</h1>
        <Select
          label="Color scheme"
          value={scheme}
          onChange={(event) => setScheme(event.target.value as UiColorScheme)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          data-testid="scheme-select"
        />
      </header>
      <main id="ui-kit-main" className={styles.main} tabIndex={-1}>
        <p className={styles.output}>
          Last action: <output data-testid="last-action">{last}</output>
        </p>
        <ToolbarSection report={report} />
        <MenuSection report={report} />
        <DialogSection report={report} />
        <ButtonSection report={report} />
        <PopoverSection report={report} />
        <ToastSection />
        <TabsSection />
        <FormSection />
        <LayoutSection />
        <IconSection />
      </main>
      {/* Toasts render through the app-wide <Toaster /> in App.tsx. */}
    </UiRoot>
  );
}

type Report = (what: string) => void;

function Section({ title, id, wide = false, children }: { title: string; id: string; wide?: boolean; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className={wide ? `${styles.section} ${styles.wide}` : styles.section} data-testid={`section-${id}`}>
      <h2 id={`${id}-title`} className={styles.sectionTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ToolbarSection({ report }: { report: Report }) {
  const [marks, setMarks] = useState({ bold: false, italic: false });
  const [block, setBlock] = useState('paragraph');
  const { zoom, spread, zoomIn, zoomOut, setZoom, setSpread } = useUiStore(
    useShallow((s) => ({ zoom: s.zoom, spread: s.spread, zoomIn: s.zoomIn, zoomOut: s.zoomOut, setZoom: s.setZoom, setSpread: s.setSpread })),
  );
  const blockItems: MenuEntry[] = (
    [
      { id: 'paragraph', label: 'Paragraph', icon: 'paragraph' },
      { id: 'h1', label: 'Heading 1', icon: 'heading1' },
      { id: 'h2', label: 'Heading 2', icon: 'heading2' },
      { id: 'h3', label: 'Heading 3', icon: 'heading3' },
    ] as const
  ).map((item) => ({ ...item, type: 'radio' as const, checked: block === item.id, onSelect: () => setBlock(item.id) }));
  const spreadItems: MenuEntry[] = (['single', 'facing', 'flow'] as const).map((id) => ({
    id,
    type: 'radio' as const,
    label: SPREAD_LABELS[id],
    icon: SPREAD_ICONS[id],
    checked: spread === id,
    onSelect: () => setSpread(id),
  }));
  const zoomItems: MenuEntry[] = [0.5, 0.75, 1, 1.5, 2].map((z) => ({
    id: String(z),
    type: 'radio' as const,
    label: `${Math.round(z * 100)}%`,
    checked: zoom === z,
    onSelect: () => setZoom(z),
  }));
  return (
    <Section title="Toolbar" id="toolbar" wide>
      <Toolbar label="Formatting" data-testid="toolbar">
        <ToolbarGroup label="History">
          <IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" aria-keyshortcuts="Control+Z" onClick={() => report('undo')} />
          <IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" onClick={() => report('redo')} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Block">
          <MenuButton label={BLOCK_LABELS[block] ?? 'Block'} items={blockItems} variant="ghost" menuLabel="Block type" data-testid="block-type" />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Marks">
          <IconButton icon="bold" label="Bold" shortcut="Ctrl+B" pressed={marks.bold} onClick={() => setMarks((m) => ({ ...m, bold: !m.bold }))} />
          <IconButton icon="italic" label="Italic" shortcut="Ctrl+I" pressed={marks.italic} onClick={() => setMarks((m) => ({ ...m, italic: !m.italic }))} />
          <IconButton icon="underline" label="Underline" shortcut="Ctrl+U" disabled />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup label="Zoom">
          <IconButton icon="zoomOut" label="Zoom out" onClick={zoomOut} />
          <MenuButton label={`${Math.round(zoom * 100)}%`} items={zoomItems} variant="ghost" menuLabel="Zoom" data-testid="zoom-menu" />
          <IconButton icon="zoomIn" label="Zoom in" onClick={zoomIn} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <MenuButton label="Spread" iconOnly icon={SPREAD_ICONS[spread]} items={spreadItems} data-testid="spread-menu" />
      </Toolbar>
      <p className={styles.output}>
        Marks: <output data-testid="marks">{JSON.stringify(marks)}</output> · zoom <output data-testid="zoom">{zoom}</output> · spread{' '}
        <output data-testid="spread">{spread}</output>
      </p>
    </Section>
  );
}

function MenuSection({ report }: { report: Report }) {
  const [wide, setWide] = useState(false);
  const [align, setAlign] = useState('left');
  const items: MenuEntry[] = [
    { id: 'table', label: 'Table', icon: 'table', onSelect: () => report('insert table') },
    { id: 'image', label: 'Image', icon: 'image', shortcut: 'Ctrl+Shift+I', onSelect: () => report('insert image') },
    { id: 'page-break', label: 'Page break', icon: 'pageBreak', shortcut: 'Ctrl+Enter', onSelect: () => report('insert page break') },
    { id: 'column-break', label: 'Column break', icon: 'columnBreak', onSelect: () => report('insert column break') },
    { id: 'toc', label: 'Table of contents', disabled: true, onSelect: () => report('toc') },
    { type: 'separator' },
    { id: 'wide', type: 'checkbox', label: 'Wide', checked: wide, onCheckedChange: setWide, closeOnSelect: false },
    {
      type: 'group',
      id: 'align',
      label: 'Alignment',
      items: [
        { id: 'align-left', type: 'radio', label: 'Left', icon: 'alignLeft', checked: align === 'left', onSelect: () => setAlign('left') },
        { id: 'align-center', type: 'radio', label: 'Center', icon: 'alignCenter', checked: align === 'center', onSelect: () => setAlign('center') },
        { id: 'align-right', type: 'radio', label: 'Right', icon: 'alignRight', checked: align === 'right', onSelect: () => setAlign('right') },
      ],
    },
  ];
  return (
    <Section title="Menu" id="menu">
      <div className={styles.row}>
        <MenuButton label="Insert" icon="insert" items={items} data-testid="insert-menu" />
        <MenuButton label="More actions" iconOnly icon="more" items={[{ id: 'copy', label: 'Copy link', icon: 'copy', onSelect: () => report('copy link') }]} />
      </div>
      <p className={styles.output}>
        wide <output data-testid="menu-wide">{String(wide)}</output> · align <output data-testid="menu-align">{align}</output>
      </p>
    </Section>
  );
}

function DialogSection({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [title, setTitle] = useState('My brew');
  return (
    <Section title="Dialog" id="dialog">
      <div className={styles.row}>
        <Button onClick={() => setOpen(true)} data-testid="open-dialog">
          Open dialog
        </Button>
        <Button variant="danger" icon="trash" onClick={() => setConfirm(true)} data-testid="open-confirm">
          Delete brew…
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Brew properties"
        description="Changes apply when you save."
        data-testid="dialog"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                report(`saved ${title}`);
                setOpen(false);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <TextField label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <Select
            label="Theme"
            options={[
              { value: '5ePHB', label: '5e PHB' },
              { value: '5eDMG', label: '5e DMG' },
              { value: 'Blank', label: 'Blank' },
            ]}
          />
          <MenuButton label="Language" items={[{ id: 'en', label: 'English', onSelect: () => report('lang en') }]} />
          <Button
            onClick={() =>
              toast({ title: 'Raised from the dialog', tone: 'info', action: { label: 'Undo', onAction: () => report('undo from toast') } })
            }
            data-testid="dialog-notify"
          >
            Notify
          </Button>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this brew?"
        message="It is removed for everyone. This cannot be undone."
        tone="danger"
        confirmLabel="Delete"
        onConfirm={() => report('deleted')}
        onCancel={() => report('delete cancelled')}
      />
    </Section>
  );
}

function ButtonSection({ report }: { report: Report }) {
  const [loading, setLoading] = useState(false);
  return (
    <Section title="Buttons" id="buttons">
      <div className={styles.row}>
        <Button variant="primary" onClick={() => report('primary')}>
          Primary
        </Button>
        <Button onClick={() => report('secondary')}>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button disabled>Disabled</Button>
      </div>
      <div className={styles.row}>
        <Button size="sm" icon="plus">
          Small
        </Button>
        <Button
          loading={loading}
          icon="saved"
          onClick={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 1500);
          }}
          data-testid="loading-button"
        >
          Save
        </Button>
        <IconButton icon="settings" label="Settings" variant="secondary" />
        <IconButton icon="trash" label="Delete" size="sm" />
      </div>
      <div className={styles.row}>
        <Tooltip content="Tooltips show on hover and keyboard focus" shortcut="Esc hides">
          <Button data-testid="tooltip-trigger">With tooltip</Button>
        </Tooltip>
        <Spinner label="Loading brews" />
        <span className={styles.output}>
          <Icon name="saving" label="Saving" /> <Icon name="saved" label="Saved" /> <Icon name="saveError" label="Save failed" />
        </span>
      </div>
    </Section>
  );
}

function PopoverSection({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('https://');
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <Section title="Popover" id="popover">
      <div className={styles.row}>
        <Button
          ref={anchor}
          icon="link"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="ui-kit-link-popover"
          onClick={() => setOpen(!open)}
          data-testid="popover-trigger"
        >
          Edit link
        </Button>
        <Button onClick={() => report('after popover')}>After popover</Button>
      </div>
      <Popover id="ui-kit-link-popover" open={open} onOpenChange={setOpen} anchorRef={anchor} aria-label="Link" data-testid="popover">
        <div className={styles.form}>
          <TextField label="URL" type="url" value={url} onChange={(event) => setUrl(event.target.value)} />
          <Button
            variant="primary"
            onClick={() => {
              report(`link ${url}`);
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      </Popover>
    </Section>
  );
}

function ToastSection() {
  const [count, setCount] = useState(0);
  return (
    <Section title="Toasts" id="toasts">
      <div className={styles.row}>
        <Button
          onClick={() => {
            setCount(count + 1);
            toast({ title: 'Brew saved', description: `Version ${count + 1}`, tone: 'success' });
          }}
          data-testid="toast-info"
        >
          Show toast
        </Button>
        <Button
          onClick={() =>
            toast({
              id: 'save-error',
              title: "Couldn't save the brew",
              description: 'Could not reach the server.',
              tone: 'error',
              action: { label: 'Retry', onAction: () => toast({ title: 'Retried', tone: 'info', duration: 1500 }) },
            })
          }
          data-testid="toast-error"
        >
          Show error with Retry
        </Button>
        <Button onClick={() => toast({ title: 'Heads up', description: 'A short one.', tone: 'warning', duration: 1200 })} data-testid="toast-short">
          Short toast
        </Button>
      </div>
      <p className={styles.output}>F8 moves focus to the toasts.</p>
    </Section>
  );
}

function TabsSection() {
  const inspectorTab = useUiStore((s) => s.inspectorTab);
  return (
    <Section title="Tabs" id="tabs">
      <Tabs
        label="Inspector"
        value={inspectorTab}
        onValueChange={(tab) => uiStore.getState().setInspectorTab(tab)}
        data-testid="tabs"
        items={[
          { id: 'node', label: 'Node', content: <p>Classes, style, id and attributes of the selection.</p> },
          { id: 'page', label: 'Page', content: <p>Section settings, markers and page objects.</p> },
          { id: 'locked', label: 'Document', content: <p>Unavailable</p>, disabled: true },
          { id: 'help', label: 'Help', content: <p>Keyboard shortcuts.</p> },
        ]}
      />
    </Section>
  );
}

function FormSection() {
  const pageShadows = useUiStore((s) => s.pageShadows);
  const [handle, setHandle] = useState('x');
  return (
    <Section title="Form fields" id="forms">
      <div className={styles.form}>
        <TextField
          label="Handle"
          hint="3-32 characters: a-z, 0-9, _ and -"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          error={handle.length < 3 ? 'Too short' : undefined}
          required
        />
        <TextArea label="Description" hint="Plain text, 500 characters at most." rows={3} />
        <Select label="Language" placeholder="Choose…" options={[{ value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' }]} />
        <Checkbox label="Published" hint="Listed in the vault and on your page." />
        <Switch label="Page shadows" checked={pageShadows} onChange={(event) => uiStore.getState().setPageShadows(event.target.checked)} />
        <TextField label="Search brews" hideLabel placeholder="Search brews" type="search" />
      </div>
    </Section>
  );
}

function LayoutSection() {
  const panels = useUiStore((s) => s.panels);
  const outlineToggle = useRef<HTMLButtonElement>(null);
  const inspectorToggle = useRef<HTMLButtonElement>(null);
  const styleToggle = useRef<HTMLButtonElement>(null);
  const { setPanelOpen, setPanelSize, togglePanel } = uiStore.getState();
  return (
    <Section title="Split panels and drawers" id="layout" wide>
      <div className={styles.layout}>
        <SplitPanel>
          <Drawer
            side="left"
            id="ui-kit-outline"
            title="Outline"
            open={panels.outline.open}
            onOpenChange={(open) => setPanelOpen('outline', open)}
            size={panels.outline.size}
            onSizeChange={(size) => setPanelSize('outline', size)}
            minSize={160}
            maxSize={480}
            resizeLabel="Resize outline"
            closeLabel="Close outline"
            returnFocusRef={outlineToggle}
            data-testid="drawer-outline"
          >
            <ul>
              <li>Chapter 1</li>
              <li>Chapter 2</li>
            </ul>
          </Drawer>
          <SplitMain>
            <SplitPanel direction="column">
              <SplitMain>
                <div className={styles.canvasStandIn}>
                  <div className={styles.row}>
                    <Button ref={outlineToggle} icon="panelLeft" pressed={panels.outline.open} onClick={() => togglePanel('outline')}>
                      Outline
                    </Button>
                    <Button ref={inspectorToggle} icon="panelRight" pressed={panels.inspector.open} onClick={() => togglePanel('inspector')}>
                      Inspector
                    </Button>
                    <Button ref={styleToggle} icon="braces" pressed={panels.style.open} onClick={() => togglePanel('style')}>
                      Style
                    </Button>
                  </div>
                  <p className={styles.output}>
                    UI store: <output data-testid="ui-state">{JSON.stringify(panels)}</output>
                  </p>
                </div>
              </SplitMain>
              <Drawer
                side="bottom"
                id="ui-kit-style"
                title="Style"
                open={panels.style.open}
                onOpenChange={(open) => setPanelOpen('style', open)}
                size={Math.min(panels.style.size, 260)}
                onSizeChange={(size) => setPanelSize('style', size)}
                minSize={240}
                maxSize={260}
                resizeLabel="Resize style editor"
                closeLabel="Close style editor"
                returnFocusRef={styleToggle}
                data-testid="drawer-style"
              >
                <div className={styles.panelBody}>
                  <TextArea label="Brew CSS" hideLabel rows={4} defaultValue=".page { }" />
                </div>
              </Drawer>
            </SplitPanel>
          </SplitMain>
          <Drawer
            side="right"
            id="ui-kit-inspector"
            title="Inspector"
            open={panels.inspector.open}
            onOpenChange={(open) => setPanelOpen('inspector', open)}
            size={panels.inspector.size}
            onSizeChange={(size) => setPanelSize('inspector', size)}
            minSize={240}
            maxSize={560}
            resizeLabel="Resize inspector"
            closeLabel="Close inspector"
            returnFocusRef={inspectorToggle}
            data-testid="drawer-inspector"
          >
            <div className={styles.panelBody}>
              <TextField label="Classes" defaultValue="note wide" />
            </div>
          </Drawer>
        </SplitPanel>
      </div>
    </Section>
  );
}

function IconSection() {
  return (
    <Section title="Icons" id="icons" wide>
      <ul className={styles.icons}>
        {ICON_NAMES.map((name) => (
          <li key={name} className={styles.iconCell}>
            <Icon name={name} size={20} />
            {name}
          </li>
        ))}
      </ul>
    </Section>
  );
}
