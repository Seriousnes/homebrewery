// Test helpers for the save lane (Vitest only; never import from app code).
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ApiError, type BrewForEdit, type SaveBrewResponse } from '@/api';
import { buildEditorExtensions } from '../editorExtensions';
import { Pagination } from '../pagination/extension';
import { PAGINATE } from '../pagination/state';
import type { PageLayout } from '../pagination/step';
import { DOC_SCHEMA_VERSION } from '../schema/version';
import type { AutosaveApi } from './autosave';
import { memoryStore } from './kvStore';
import type { Draft } from './drafts';
import { createSnapshotHistory, type Snapshot } from './snapshots';

export const paragraph = (text: string): JSONContent => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });

/** A one-page document with one paragraph per argument. */
export const docOf = (...texts: string[]): JSONContent => ({
  type: 'doc',
  content: [{ type: 'page', attrs: { pid: 'page0001' }, content: texts.map(paragraph) }],
});

/** A layout where every page fits: each pagination pass settles after one step per page. */
export const fitsLayout: PageLayout = {
  measure: () => ({ overflow: false }),
  chooseCut: () => ({ pos: null, oversized: false, rule: 'none' }),
  pullTarget: () => null,
};

export interface MountedEditor {
  editor: Editor;
  /** Pending animation frames of the pagination scheduler (paginate: true). */
  frames: (() => void)[];
  /** Runs animation frames until pagination settles. */
  settle: () => void;
}

/** A real TipTap editor (jsdom), optionally with the pagination plugin on manual frames. */
export function mountEditor(content: JSONContent, { paginate = false }: { paginate?: boolean } = {}): MountedEditor {
  const frames: (() => void)[] = [];
  const editor = new Editor({
    extensions: buildEditorExtensions({
      extensions: paginate
        ? [
            Pagination.configure({
              layout: () => fitsLayout,
              requestFrame: (callback) => frames.push(callback),
              cancelFrame: () => {},
              now: () => 0,
              logger: { warn: () => {}, error: () => {} },
            }),
          ]
        : [],
    }),
    content,
  });
  return {
    editor,
    frames,
    settle() {
      for (let i = 0; i < 1000 && frames.length; i++) {
        for (const callback of frames.splice(0)) callback();
      }
    },
  };
}

function textEnd(doc: PMNode, index: number): number {
  let found = -1;
  let seen = 0;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock) {
      if (seen === index) {
        found = pos + 1 + node.content.size;
        return false;
      }
      seen++;
    }
    return true;
  });
  if (found < 0) throw new Error(`No text block ${index}`);
  return found;
}

/** Types `text` at the end of text block `index` (an author's change: one history step). */
export function typeText(editor: Editor, text: string, index = 0): void {
  editor.view.dispatch(editor.state.tr.insertText(text, textEnd(editor.state.doc, index)));
}

/** A document change that pagination made (PAGINATE meta, outside the history). */
export function paginationChange(editor: Editor, text = '~'): void {
  const tr = editor.state.tr.insertText(text, textEnd(editor.state.doc, 0));
  tr.setMeta('addToHistory', false).setMeta(PAGINATE, { dirtyFrom: null, dirtyTo: 0, action: 'push' });
  editor.view.dispatch(tr);
}

/** The text of every paragraph. */
export const texts = (editor: Editor): string[] => {
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isTextblock) out.push(node.textContent);
    return !node.isTextblock;
  });
  return out;
};

export function brewForEdit(overrides: Partial<BrewForEdit> = {}): BrewForEdit {
  return {
    editId: 'edit-1',
    shareId: 'share-1',
    version: 1,
    docSchemaVersion: DOC_SCHEMA_VERSION,
    doc: docOf('Hello'),
    style: '',
    snippets: null,
    sourceMarkdown: null,
    meta: { title: 'Brew', description: '', tags: [], lang: 'en', theme: '5ePHB', published: false, thumbnailUrl: null },
    authors: [{ handle: 'me', role: 'owner' }],
    role: 'owner',
    pageCount: 1,
    views: 0,
    lock: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    updatedAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

export function saveResponse(version: number, overrides: Partial<SaveBrewResponse> = {}): SaveBrewResponse {
  return { version, updatedAt: new Date().toISOString(), title: 'Brew', pageCount: 1, authors: [{ handle: 'me', role: 'owner' }], ...overrides };
}

export const httpError = (status: number, extensions: Record<string, unknown> = {}, retryAfter: number | null = null): ApiError =>
  new ApiError({ kind: 'http', status, title: `HTTP ${status}`, extensions, retryAfter });

export const conflictError = (serverVersion: number): ApiError => httpError(409, { serverVersion });

export const networkError = (): ApiError => ApiError.network(new TypeError('Failed to fetch'));

/** A deferred promise, to hold a request open. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface FakeApi extends AutosaveApi {
  calls: { method: 'save' | 'create' | 'fetch'; editId?: string; body?: unknown; options?: unknown }[];
}

/**
 * An AutosaveApi whose answers come from `handler` (default: every save succeeds with the next
 * version, creates return 'new-1', fetch returns brewForEdit()).
 */
export function fakeApi(handler: Partial<AutosaveApi> = {}): FakeApi {
  const calls: FakeApi['calls'] = [];
  let version = 1;
  return {
    calls,
    saveBrew: (editId, body, options) => {
      calls.push({ method: 'save', editId, body, options });
      if (handler.saveBrew) return handler.saveBrew(editId, body, options);
      version = body.baseVersion + 1;
      return Promise.resolve(saveResponse(version));
    },
    createBrew: (body, options) => {
      calls.push({ method: 'create', body, options });
      if (handler.createBrew) return handler.createBrew(body, options);
      return Promise.resolve(brewForEdit({ editId: 'new-1', shareId: 'new-share', version: 1, doc: body.doc as JSONContent }));
    },
    fetchBrewForEdit: (editId) => {
      calls.push({ method: 'fetch', editId });
      if (handler.fetchBrewForEdit) return handler.fetchBrewForEdit(editId);
      return Promise.resolve(brewForEdit({ editId }));
    },
  };
}

export const memoryDrafts = (initial: [string, Draft][] = []) => memoryStore<Draft>(initial);

export function memorySnapshots(now: () => number = Date.now) {
  const store = memoryStore<Snapshot>();
  return { store, history: createSnapshotHistory(store, now) };
}

export function draftOf(overrides: Partial<Draft> = {}): Draft {
  return {
    v: 1,
    key: 'edit-1',
    editId: 'edit-1',
    baseVersion: 1,
    pendingVersion: null,
    doc: docOf('Hello world'),
    style: '',
    snippets: null,
    meta: null,
    docSchemaVersion: DOC_SCHEMA_VERSION,
    updatedAt: Date.parse('2026-09-25T10:05:00.000Z'),
    ...overrides,
  };
}
