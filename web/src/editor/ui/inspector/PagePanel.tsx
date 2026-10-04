import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { clsx } from 'clsx';
import { useId, useState } from 'react';
import {
  addPageObjectClasses,
  addSectionClasses,
  COVER_MARKERS,
  coverOf,
  editMarkers,
  editPageObject,
  editSection,
  removeAttribute,
  setAttribute,
  withCover,
  withMarker,
  type CoverMarker,
  type Dispatch,
  type EditResult,
} from '@/editor/commands/attrs';
import { pageAt } from '@/editor/pagination/boundary';
import { Checkbox, Icon, Select, Switch } from '@/ui';
import { useAnnounce } from './announce';
import { AttributesField } from './AttributesField';
import { ClassField } from './ClassField';
import { CommitField } from './CommitField';
import type { ClassPickerMode } from '../classPicker/themeClasses';
import { COLUMN_LABELS, themeDefaultLabel } from '../columns/columnsMenu';
import type { ClassSuggester } from './classNames';
import styles from './Inspector.module.css';
import { resolvePage, type ObjectInfo, type PageInfo } from './model';
import type { PageObjectRef } from './objectFocus';

export interface PagePanelProps {
  editor: Editor;
  page: PageInfo | null;
  suggestions: (mode: ClassPickerMode) => ClassSuggester;
  onSelectObject: (ref: PageObjectRef) => void;
  /** The editor is read-only: the fields show the values, disabled (the objects list still selects). */
  readOnly?: boolean;
}

const COVER_LABELS: Record<CoverMarker, string> = {
  frontCover: 'Front cover',
  insideCover: 'Inside cover',
  partCover: 'Part cover',
  backCover: 'Back cover',
};
/** The Columns options; the theme default names the count the canvas shows (themeDefaultLabel). */
const columnOptions = (themeLabel: string) => [
  { value: 'theme', label: themeLabel },
  { value: '1', label: COLUMN_LABELS['1'] },
  { value: '2', label: COLUMN_LABELS['2'] },
];

const STALE: EditResult = { ok: false, error: 'The page changed before the edit was applied; nothing was changed.' };
/** An edit attempted while the editor is read-only (the fields are disabled then). */
const READ_ONLY: EditResult = { ok: false, error: 'The document is read-only; nothing was changed.' };

/** Section settings, markers, attributes and objects of the page that holds the selection. */
export function PagePanel({ editor, page, suggestions, onSelectObject, readOnly = false }: PagePanelProps) {
  if (!page) return <p className={styles.placeholder}>This document has no pages.</p>;
  // Keyed by page: drafts and the selected object belong to one page.
  return <PageFields key={page.pid ?? `#${page.index}`} editor={editor} page={page} suggestions={suggestions} onSelectObject={onSelectObject} readOnly={readOnly} />;
}

function PageFields({ editor, page, suggestions, onSelectObject, readOnly = false }: PagePanelProps & { page: PageInfo }) {
  const sectionId = useId();
  const pageId = useId();
  const objectsId = useId();
  const announce = useAnnounce();
  const [selectedObject, setSelectedObject] = useState<string | null>(null);

  /** Runs an edit on this page's index as it is now; refuses if the selection is on another page. */
  const edit = (run: (state: EditorState, dispatch: Dispatch, index: number) => EditResult): EditResult => {
    if (editor.isDestroyed) return STALE;
    if (!editor.isEditable) return READ_ONLY;
    const now = resolvePage(editor.state);
    if (!now || now.pid !== page.pid || (page.pid === null && now.index !== page.index)) return STALE;
    return run(editor.state, (tr) => editor.view.dispatch(tr), now.index);
  };
  /** For controls that apply at once (selects, switches): errors are announced. */
  const act = (run: (state: EditorState, dispatch: Dispatch, index: number) => EditResult) => {
    const result = edit(run);
    if (!result.ok) announce(result.error);
  };

  const { section } = page;
  const settings = section.settings;
  const cover = coverOf(page.markers);
  const sectionPages =
    section.start === section.end ? `page ${section.start + 1}` : `pages ${section.start + 1}–${section.end + 1}`;
  const object = page.objects.find((o) => o.id === selectedObject) ?? null;
  /** The fields of a group; disabled (showing the values) while the editor is read-only. */
  const fields = clsx(styles.fields, styles.bareFieldset);

  return (
    <div className={styles.panel}>
      <div className={styles.targetHeader}>
        <h3 className={styles.targetTitle} data-testid="inspector-page-title">
          Page {page.index + 1} of {page.count}
        </h3>
        <p className={styles.note} data-testid="inspector-page-kind">
          {page.kind === 'auto'
            ? `Created by page flow. Section settings apply to ${sectionPages}, from page ${section.start + 1}.`
            : `Starts a section (${sectionPages}).`}
        </p>
        <p className={styles.note} data-testid="inspector-page-link">
          Links to this page use <code className={styles.mono}>#p{page.index + 1}</code>.
        </p>
      </div>

      <section aria-labelledby={sectionId} className={styles.group} data-testid="inspector-section">
        <h4 id={sectionId} className={styles.groupTitle}>
          Section
        </h4>
        <fieldset className={fields} disabled={readOnly}>
          <Select
            label="Columns"
            options={columnOptions(themeDefaultLabel(editor, settings.columns, page.index))}
            value={settings.columns === null ? 'theme' : String(settings.columns)}
            onChange={(event) => {
              const value = event.target.value;
              const columns = value === '1' ? 1 : value === '2' ? 2 : null;
              act((s, d, i) => editSection(s, d, i, { columns }));
            }}
            data-testid="inspector-columns"
          />
          <Switch
            label="Page numbers"
            hint="On every page of this section."
            checked={settings.pageNumber}
            onChange={(event) => act((s, d, i) => editSection(s, d, i, { pageNumber: event.target.checked }))}
            data-testid="inspector-page-number"
          />
          <CommitField
            label="Footer"
            value={settings.footer ?? ''}
            placeholder="Part 1 | Chapter title"
            hint="Shown at the foot of every page of this section."
            onCommit={(text) => edit((s, d, i) => editSection(s, d, i, { footer: text }))}
            data-testid="inspector-footer"
          />
          <ClassField
            label="Section classes"
            addLabel="Add section class"
            classes={settings.classes}
            suggestions={() => suggestions('themeBlock')}
            onAdd={(text) => edit((s, d, i) => addSectionClasses(s, d, i, text))}
            onRemove={(name) => edit((s, d, i) => editSection(s, d, i, { classes: settings.classes.filter((c) => c !== name) }))}
            data-testid="inspector-section-classes"
          />
          <CommitField
            label="Section style"
            multiline
            monospace
            rows={2}
            value={settings.style ?? ''}
            placeholder="background-color: …"
            hint="CSS declarations for every page of this section."
            onCommit={(text) => edit((s, d, i) => editSection(s, d, i, { style: text }))}
            data-testid="inspector-section-style"
          />
        </fieldset>
      </section>

      <section aria-labelledby={pageId} className={styles.group} data-testid="inspector-this-page">
        <h4 id={pageId} className={styles.groupTitle}>
          This page
        </h4>
        <fieldset className={fields} disabled={readOnly}>
          <Select
            label="Cover"
            options={[{ value: '', label: 'Not a cover' }, ...COVER_MARKERS.map((m) => ({ value: m, label: COVER_LABELS[m] }))]}
            value={cover ?? ''}
            hint={page.kind === 'auto' ? 'A page with markers stays, blank if its text flows back to the page before.' : undefined}
            onChange={(event) => {
              const value = event.target.value as CoverMarker | '';
              act((s, d, i) => editMarkers(s, d, i, withCover(markersOf(s, i), value === '' ? null : value)));
            }}
            data-testid="inspector-cover"
          />
          <Checkbox
            label="Skip this page when counting"
            checked={page.markers.includes('skipCounting')}
            onChange={(event) => act((s, d, i) => editMarkers(s, d, i, withMarker(markersOf(s, i), 'skipCounting', event.target.checked)))}
            data-testid="inspector-skip-counting"
          />
          <Checkbox
            label="Restart page numbers here"
            checked={page.markers.includes('resetCounting')}
            onChange={(event) => act((s, d, i) => editMarkers(s, d, i, withMarker(markersOf(s, i), 'resetCounting', event.target.checked)))}
            data-testid="inspector-reset-counting"
          />
          <AttributesField
            attributes={page.attributes}
            onSet={(name, value, previous) => edit((s, d, i) => withPage(s, i, (target) => setAttribute(s, d, target, name, value, previous)))}
            onRemove={(name) => edit((s, d, i) => withPage(s, i, (target) => removeAttribute(s, d, target, name)))}
            data-testid="inspector-page-attributes"
          />
        </fieldset>
      </section>

      <section aria-labelledby={objectsId} className={styles.group} data-testid="inspector-objects">
        <h4 id={objectsId} className={styles.groupTitle}>
          Objects
        </h4>
        {page.objects.length === 0 ? (
          <p className={styles.none}>No objects on this page.</p>
        ) : (
          <ul className={styles.objectList}>
            {page.objects.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={clsx(styles.objectItem, o.id === selectedObject && styles.objectItemSelected)}
                  aria-pressed={o.id === selectedObject}
                  onClick={() => {
                    setSelectedObject(o.id);
                    onSelectObject({ pageIndex: page.index, id: o.id });
                  }}
                  data-testid={`inspector-object-${o.id}`}
                >
                  <Icon name={o.kind === 'image' ? 'image' : 'paragraph'} size={14} />
                  <span className={styles.objectLabel}>{o.label}</span>
                  {o.classes.length > 0 ? <span className={styles.crumbClasses}>.{o.classes.join('.')}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        {object ? (
          <fieldset className={fields} disabled={readOnly}>
            <ObjectFields key={object.id} object={object} suggestions={suggestions} edit={edit} />
          </fieldset>
        ) : null}
      </section>
    </div>
  );
}

function ObjectFields({
  object,
  suggestions,
  edit,
}: {
  object: ObjectInfo;
  suggestions: (mode: ClassPickerMode) => ClassSuggester;
  edit: (run: (state: EditorState, dispatch: Dispatch, index: number) => EditResult) => EditResult;
}) {
  const kind = object.kind === 'image' ? 'Image' : 'Text';
  return (
    <div className={styles.objectFields} role="group" aria-label={`${kind} object ${object.label}`} data-testid="inspector-object-fields">
      <ClassField
        label="Object classes"
        addLabel="Add object class"
        classes={object.classes}
        suggestions={() => suggestions('span')}
        onAdd={(text) => edit((s, d, i) => addPageObjectClasses(s, d, i, object.id, text))}
        onRemove={(name) => edit((s, d, i) => editPageObject(s, d, i, object.id, { classes: object.classes.filter((c) => c !== name) }))}
        data-testid="inspector-object-classes"
      />
      <CommitField
        label="Object style"
        multiline
        monospace
        rows={3}
        value={object.style}
        placeholder="position: absolute; top: 0; left: 0"
        hint="Position and size on the page."
        onCommit={(text) => edit((s, d, i) => editPageObject(s, d, i, object.id, { style: text }))}
        data-testid="inspector-object-style"
      />
    </div>
  );
}

function markersOf(state: EditorState, index: number): string[] {
  const markers: unknown = state.doc.maybeChild(index)?.attrs.markers;
  return Array.isArray(markers) ? (markers as string[]) : [];
}

function withPage(state: EditorState, index: number, run: (target: { kind: 'node'; pos: number }) => EditResult): EditResult {
  const page = pageAt(state.doc, index);
  return page ? run({ kind: 'node', pos: page.pos }) : STALE;
}
