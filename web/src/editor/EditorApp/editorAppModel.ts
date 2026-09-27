// The composed editor's data model (plan §9): what EditorApp needs to know about the brew it
// shows, built from the API's BrewForEdit / BrewForShare, a /new draft or the bundled welcome
// brew. Pure helpers only (no React), so pages and tests can use them.
import type { JSONContent } from '@tiptap/core';
import type { PanelId } from '@/app/uiStore';
import type { AuthorRole, BrewAuthorInfo, BrewForEdit, BrewForShare, BrewLockInfo, BrewMeta, BrewMetaInput } from '@/api';
import type { LocalBrew } from '@/editor/local/localBrews';
import type { BrewBaseline, Draft } from '@/editor/save';
import { migrateDoc } from '@/editor/schema/migrations';
import { DOC_SCHEMA_VERSION } from '@/editor/schema/version';

/** 'edit': the editable editor with toolbars and panels; 'view': read-only (share page). */
export type EditorAppMode = 'edit' | 'view';

/**
 * 'server': autosave (edit and new pages); 'local': the browser's local brew library (issue #4,
 * no account needed); 'none': never saved (home, share).
 */
export type EditorAppSaving = 'server' | 'local' | 'none';

export const DEFAULT_THEME = '5ePHB';
export const DEFAULT_LANG = 'en';
export const UNTITLED = 'Untitled brew';

/** The drawers' element ids (the panels' defaults; aria-controls of their toggles while open). */
export const PANEL_ELEMENT_IDS: Readonly<Record<PanelId, string>> = {
  outline: 'hb-outline-panel',
  style: 'hb-style-panel',
  inspector: 'hb-inspector-panel',
};

/** The brew EditorApp shows: its ids, version, metadata and non-document content. */
export interface EditorAppBrew {
  /** null: never saved (/new before its first save, the home page, a share view for non-authors). */
  editId: string | null;
  shareId: string | null;
  /** BrewForEdit.version (the next save's baseVersion); null when never saved. */
  version: number | null;
  meta: BrewMeta;
  style: string;
  snippets: unknown;
  authors: BrewAuthorInfo[];
  /** The caller's role; null = not saved yet (the caller will own it) or not an author. */
  role: AuthorRole | null;
  lock: BrewLockInfo | null;
  updatedAt: string | null;
}

/** One empty manual page (what /new starts from). */
export function blankDoc(): JSONContent {
  return { type: 'doc', content: [{ type: 'page', content: [{ type: 'paragraph' }] }] };
}

/** Metadata of a brew that was never saved (the server's defaults for a create). */
export function defaultMeta(overrides: Partial<BrewMeta> = {}): BrewMeta {
  return {
    title: '',
    description: '',
    tags: [],
    lang: DEFAULT_LANG,
    theme: DEFAULT_THEME,
    published: false,
    thumbnailUrl: null,
    ...overrides,
  };
}

/** Whether this client can open a document stored with this docSchemaVersion (not a newer one). */
export function isOpenableVersion(docSchemaVersion: number): boolean {
  return Number.isInteger(docSchemaVersion) && docSchemaVersion >= 1 && docSchemaVersion <= DOC_SCHEMA_VERSION;
}

/** A stored document as the editor's initial content: migrated to the current schema version. */
export function docForEditor(doc: unknown, docSchemaVersion: number): JSONContent {
  if (!doc || typeof doc !== 'object' || (doc as JSONContent).type !== 'doc') return blankDoc();
  return migrateDoc(doc, docSchemaVersion);
}

export function appBrewFromEdit(brew: BrewForEdit): EditorAppBrew {
  return {
    editId: brew.editId,
    shareId: brew.shareId,
    version: brew.version,
    meta: brew.meta,
    style: brew.style ?? '',
    snippets: brew.snippets ?? null,
    authors: brew.authors,
    role: brew.role,
    lock: brew.lock ?? null,
    updatedAt: brew.updatedAt,
  };
}

/** A share view: read-only, never saved. editId is set only for the brew's authors. */
export function appBrewFromShare(brew: BrewForShare): EditorAppBrew {
  return {
    editId: brew.editId ?? null,
    shareId: brew.shareId,
    version: null,
    meta: brew.meta,
    style: brew.style ?? '',
    snippets: null,
    authors: brew.authors.map((handle, i) => ({ handle, role: i === 0 ? 'owner' : 'author' })),
    role: null,
    lock: null,
    updatedAt: brew.updatedAt,
  };
}

/** Metadata a /new draft carried (BrewMetaInput) laid over the defaults. */
export function metaFromInput(input: BrewMetaInput | null | undefined, base: BrewMeta = defaultMeta()): BrewMeta {
  if (!input) return base;
  return {
    title: input.title ?? base.title,
    description: input.description ?? base.description,
    tags: input.tags ? [...input.tags] : base.tags,
    lang: input.lang ?? base.lang,
    theme: input.theme ?? base.theme,
    published: input.published ?? base.published,
    thumbnailUrl: input.thumbnailUrl === undefined ? base.thumbnailUrl : input.thumbnailUrl || null,
  };
}

/** The /new page's brew: blank, or what its IndexedDB draft holds. */
export function appBrewForNew(draft?: Pick<Draft, 'style' | 'snippets' | 'meta'> | null): EditorAppBrew {
  return {
    editId: null,
    shareId: null,
    version: null,
    meta: metaFromInput(draft?.meta),
    style: draft?.style ?? '',
    snippets: draft?.snippets ?? null,
    authors: [],
    role: null,
    lock: null,
    updatedAt: null,
  };
}

/** A local brew (issue #4), or a new one: never on the server, no authors, not published. */
export function appBrewForLocal(brew?: Pick<LocalBrew, 'style' | 'snippets' | 'meta'> | null): EditorAppBrew {
  return {
    editId: null,
    shareId: null,
    version: null,
    meta: defaultMeta(brew ? { ...brew.meta, tags: [...brew.meta.tags] } : {}),
    style: brew?.style ?? '',
    snippets: brew?.snippets ?? null,
    authors: [],
    role: null,
    lock: null,
    updatedAt: null,
  };
}

/** What the server holds (autosave's "Restore unsaved changes" check). */
export function baselineOf(brew: BrewForEdit): BrewBaseline {
  return { doc: brew.doc, style: brew.style, snippets: brew.snippets, meta: brew.meta };
}

/** The title to show (navbar, tab title, recent brews). */
export function displayTitle(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const t = c?.trim();
    if (t) return t;
  }
  return UNTITLED;
}

interface ShortcutEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** Ctrl-P / Cmd-P without other modifiers (the physical P key on non-Latin layouts). */
export function isPrintShortcut(event: ShortcutEvent): boolean {
  if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return false;
  const key = event.key.toLowerCase();
  return key === 'p' || (!/^[a-z]$/.test(key) && event.code === 'KeyP');
}
