// useAutosave + SaveStatus, ConflictDialog, DraftRestoreBanner and LocalHistoryDialog: the page
// events (Mod-S, visibilitychange, unmount, beforeunload), the watch rule for style edits, and
// the dialogs' flows with a real editor. Layout, focus order and axe run in e2e/save.
import type { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onSignInRequired, type SaveBrewRequest } from '@/api';
import { clearToasts, toastStore, UiRoot } from '@/ui';
import { ConflictDialog } from './ConflictDialog';
import { CreateChainContext } from './createChain';
import { DraftRestoreBanner } from './DraftRestoreBanner';
import type { Draft } from './drafts';
import { LocalHistoryDialog } from './LocalHistoryDialog';
import { SaveStatus } from './SaveStatus';
import {
  brewForEdit,
  conflictError,
  deferred,
  docOf,
  draftOf,
  fakeApi,
  httpError,
  memoryDrafts,
  memorySnapshots,
  mountEditor,
  networkError,
  saveResponse,
  texts,
  typeText,
  type FakeApi,
} from './testing';
import { isSaveShortcut, useAutosave, type UseAutosaveOptions } from './useAutosave';

let editor: Editor | undefined;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-09-25T10:00:00.000Z') });
});

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  clearToasts();
  vi.useRealTimers();
});

interface HarnessProps {
  editor: Editor;
  api: FakeApi;
  drafts?: ReturnType<typeof memoryDrafts>;
  snapshots?: ReturnType<typeof memorySnapshots>;
  options?: Partial<UseAutosaveOptions>;
}

function Harness({ editor: ed, api, drafts = memoryDrafts(), snapshots = memorySnapshots(), options }: HarnessProps) {
  const [style, setStyle] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const autosave = useAutosave({
    editor: ed,
    editId: 'edit-1',
    baseVersion: 1,
    getStyle: () => style,
    getSnippets: () => null,
    getMeta: () => ({ title: 'Brew' }),
    watch: [style],
    api,
    drafts,
    snapshots: snapshots.history,
    logger: { warn: () => {} },
    onRestore: (content) => setStyle(content.style),
    onServerBrew: (brew) => setStyle(brew.style),
    ...options,
  });
  return (
    <UiRoot>
      <SaveStatus autosave={autosave} />
      <DraftRestoreBanner autosave={autosave} />
      <ConflictDialog autosave={autosave} />
      <LocalHistoryDialog open={historyOpen} onOpenChange={setHistoryOpen} autosave={autosave} />
      <button type="button" onClick={() => setHistoryOpen(true)}>
        History
      </button>
      <label>
        Style
        <textarea value={style} onChange={(e) => setStyle(e.target.value)} />
      </label>
    </UiRoot>
  );
}

function setup(props: Partial<HarnessProps> & { draftEntries?: [string, Draft][] } = {}) {
  editor = mountEditor(docOf('Hello')).editor;
  const api = props.api ?? fakeApi();
  const drafts = props.drafts ?? memoryDrafts(props.draftEntries ?? []);
  const snapshots = props.snapshots ?? memorySnapshots(() => Date.now());
  const view = render(<Harness editor={editor} api={api} drafts={drafts} snapshots={snapshots} options={props.options} />);
  const saves = () => api.calls.filter((c) => c.method === 'save');
  return { ed: editor, api, drafts, snapshots, view, saves };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const label = () => screen.getByTestId('save-status-label').textContent;

describe('useAutosave with SaveStatus', () => {
  it('shows Saved → Unsaved changes → Saving… → Saved', async () => {
    const pending = deferred<ReturnType<typeof saveResponse>>();
    const { ed } = setup({ api: fakeApi({ saveBrew: () => pending.promise }) });
    expect(label()).toBe('Saved');
    act(() => typeText(ed, ' world'));
    expect(label()).toBe('Unsaved changes');
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-keyshortcuts', 'Control+S Meta+S');
    await advance(3000);
    expect(label()).toBe('Saving…');
    pending.resolve(saveResponse(2));
    await advance(0);
    expect(label()).toBe('Saved');
    // Autosaves are not announced; only problems and manual saves are.
    expect(screen.getByTestId('save-status-live')).toHaveTextContent('');
  });

  it('Mod-S saves at once anywhere on the page and blocks the browser dialog', async () => {
    const { ed, saves } = setup();
    act(() => typeText(ed, '!'));
    let notCancelled = true;
    act(() => {
      notCancelled = fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true });
    });
    expect(notCancelled).toBe(false);
    await advance(0);
    expect(saves()).toHaveLength(1);
    expect(label()).toBe('Saved');
    expect(screen.getByTestId('save-status-live').textContent).toMatch(/^Saved at /);
  });

  it('recognises the save shortcut', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(isSaveShortcut(key({ key: 's', ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(key({ key: 'S', metaKey: true }))).toBe(true);
    expect(isSaveShortcut(key({ key: 'ы', code: 'KeyS', ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(key({ key: 'o', code: 'KeyS', ctrlKey: true }))).toBe(false); // Dvorak: that key is O
    expect(isSaveShortcut(key({ key: 's', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSaveShortcut(key({ key: 's' }))).toBe(false);
  });

  it('saves style edits (watch) and not re-renders that change nothing', async () => {
    const { saves } = setup();
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: '.page { color: red }' } });
    expect(label()).toBe('Unsaved changes');
    await advance(3000);
    expect((saves()[0]!.body as SaveBrewRequest).style).toBe('.page { color: red }');
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: '.page { color: blue }' } });
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: '.page { color: red }' } });
    expect(label()).toBe('Unsaved changes'); // it did change in between
  });

  it('flushes with keepalive when the page is hidden, and on unmount', async () => {
    const { ed, api, view } = setup();
    act(() => typeText(ed, 'a'));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    visibility.mockRestore();
    await advance(0);
    expect(api.calls[0]).toMatchObject({ method: 'save', options: { keepalive: true, gzip: 'always' } });
    act(() => typeText(ed, 'b'));
    view.unmount();
    await advance(0);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]).toMatchObject({ options: { keepalive: true } });
  });

  it('offline: Retry saves again; beforeunload warns while changes cannot be saved', async () => {
    let online = false;
    const api = fakeApi({ saveBrew: (_id, body) => (online ? Promise.resolve(saveResponse(body.baseVersion + 1)) : Promise.reject(networkError())) });
    const { ed } = setup({ api });
    act(() => typeText(ed, 'x'));
    await advance(3000);
    expect(label()).toBe('Offline');
    expect(screen.getByTestId('save-status-live')).toHaveTextContent(/Offline\. Can’t reach the server/);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAccessibleDescription(/Can’t reach the server/);
    online = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await advance(0);
    expect(label()).toBe('Saved');
    const calm = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(calm);
    expect(calm.defaultPrevented).toBe(false);
  });

  it('401: "Sign in to save" asks the app to sign in; a new user retries', async () => {
    let signedIn = false;
    const api = fakeApi({ saveBrew: (_id, body) => (signedIn ? Promise.resolve(saveResponse(body.baseVersion + 1)) : Promise.reject(httpError(401))) });
    const signIn = vi.fn();
    const off = onSignInRequired(signIn);
    try {
      editor = mountEditor(docOf('Hello')).editor;
      const drafts = memoryDrafts();
      const view = render(<Harness editor={editor} api={api} drafts={drafts} options={{ userKey: null }} />);
      act(() => typeText(editor!, 'x'));
      await advance(3000);
      expect(label()).toBe('Not saved');
      expect([...drafts.map.values()].some((d) => d.editId === 'edit-1')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to save' }));
      expect(signIn).toHaveBeenCalledWith({ error: null });
      signedIn = true;
      view.rerender(<Harness editor={editor} api={api} drafts={drafts} options={{ userKey: 'user-1' }} />);
      await advance(0);
      expect(label()).toBe('Saved');
    } finally {
      off();
    }
  });
});

describe('while nobody is signed in (APP-9)', () => {
  it('a page shown again does not resend a save that needs a sign-in', async () => {
    const api = fakeApi({ saveBrew: () => Promise.reject(httpError(401)) });
    editor = mountEditor(docOf('Hello')).editor;
    const drafts = memoryDrafts();
    render(<Harness editor={editor} api={api} drafts={drafts} options={{ userKey: null }} />);
    act(() => typeText(editor!, 'x'));
    await advance(3000);
    expect(label()).toBe('Not saved');
    for (let i = 0; i < 3; i++) {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await advance(0);
    }
    expect(api.calls).toHaveLength(1);
  });

  it("a new brew waiting for a sign-in doesn't ask before leaving once its draft is stored", async () => {
    const api = fakeApi();
    editor = mountEditor(docOf('Hello')).editor;
    const drafts = memoryDrafts();
    render(<Harness editor={editor} api={api} drafts={drafts} options={{ editId: null, baseVersion: null, userKey: null, signedOut: true }} />);
    act(() => typeText(editor!, ' secret'));
    await advance(3000);
    expect(label()).toBe('Not saved');
    expect(screen.getByRole('button', { name: 'Sign in to save' })).toBeInTheDocument();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    expect(api.calls).toHaveLength(0);
    expect(JSON.stringify(drafts.map.get('new')?.doc)).toContain('Hello secret');
  });
});

describe('SaveStatus when the brew is out of reach (SAVE-4)', () => {
  it('403: "Save as a new brew" saves a copy', async () => {
    const onCreated = vi.fn();
    const api = fakeApi({ saveBrew: (id, body) => (id === 'edit-1' ? Promise.reject(httpError(403)) : Promise.resolve(saveResponse(body.baseVersion + 1))) });
    const { ed } = setup({ api, options: { onCreated } });
    act(() => typeText(ed, ' mine'));
    await advance(3000);
    expect(screen.getByTestId('save-status')).toHaveAttribute('data-status', 'lost');
    expect(screen.getByTestId('save-status-live')).toHaveTextContent(/new brew/);
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new brew' }));
    await advance(0);
    expect(api.calls.filter((c) => c.method === 'create')).toHaveLength(1);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ editId: 'new-1' }), 'copy');
    expect(label()).toBe('Saved');
  });
});

describe('ConflictDialog', () => {
  it('opens on 409 with the three choices; Escape leaves the conflict, Resolve… reopens it', async () => {
    const api = fakeApi({ saveBrew: () => Promise.reject(conflictError(4)) });
    const { ed } = setup({ api });
    act(() => typeText(ed, ' mine'));
    await advance(3000);
    const dialog = screen.getByRole('alertdialog', { name: 'This brew was changed somewhere else' });
    for (const name of ['Load the saved version', 'Overwrite with mine', 'Save mine as a copy']) {
      expect(within(dialog).getByRole('button', { name })).toHaveAccessibleDescription(/.+/);
    }
    expect(within(dialog).getByRole('button', { name: 'Save mine as a copy' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(label()).toBe('Conflict');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve…' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Overwrite with mine re-PUTs on the server version and closes', async () => {
    const api = fakeApi({
      saveBrew: (_id, body) => (body.baseVersion === 1 ? Promise.reject(conflictError(4)) : Promise.resolve(saveResponse(body.baseVersion + 1))),
    });
    const { ed, saves } = setup({ api });
    act(() => typeText(ed, ' mine'));
    await advance(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }));
    await advance(0);
    expect((saves()[1]!.body as SaveBrewRequest).baseVersion).toBe(4);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(label()).toBe('Saved');
  });

  it('Load the saved version applies the server brew (doc and style) and Undo brings mine back', async () => {
    const api = fakeApi({
      saveBrew: () => Promise.reject(conflictError(4)),
      fetchBrewForEdit: (id) => Promise.resolve(brewForEdit({ editId: id, version: 4, doc: docOf('Theirs'), style: '.theirs{}' })),
    });
    const { ed } = setup({ api });
    act(() => typeText(ed, ' mine'));
    await advance(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Load the saved version' }));
    await advance(0);
    expect(texts(ed)).toEqual(['Theirs']);
    expect(screen.getByLabelText('Style')).toHaveValue('.theirs{}');
    expect(label()).toBe('Saved'); // the server's style is the new baseline, not a change
    act(() => {
      ed.commands.undo();
    });
    expect(texts(ed)).toEqual(['Hello mine']);
    expect(label()).toBe('Unsaved changes');
  });

  it('shows why an action failed', async () => {
    const api = fakeApi({ saveBrew: () => Promise.reject(conflictError(4)), createBrew: () => Promise.reject(httpError(500)) });
    const { ed } = setup({ api });
    act(() => typeText(ed, ' mine'));
    await advance(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Save mine as a copy' }));
    await advance(0);
    expect(screen.getByTestId('conflict-error')).toHaveTextContent(/Couldn't save a copy/);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});

describe('DraftRestoreBanner', () => {
  it('offers a stored draft and restores it as one undo step', async () => {
    const draft = draftOf({ doc: docOf('Hello from the draft'), style: '.d{}', updatedAt: Date.now() - 5 * 60_000 });
    const { ed } = setup({ draftEntries: [['edit-1', draft]], options: { baseline: { doc: docOf('Hello'), style: '' } } });
    await advance(0);
    const banner = screen.getByRole('region', { name: 'Unsaved changes found' });
    expect(banner).toHaveTextContent('5 minutes ago');
    fireEvent.click(within(banner).getByRole('button', { name: 'Restore unsaved changes' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes found' })).toBeNull();
    expect(texts(ed)).toEqual(['Hello from the draft']);
    expect(screen.getByLabelText('Style')).toHaveValue('.d{}');
    expect(label()).toBe('Unsaved changes');
    act(() => {
      ed.commands.undo();
    });
    expect(texts(ed)).toEqual(['Hello']);
  });

  it('Discard drops the offer and the stored draft', async () => {
    const { drafts } = setup({ draftEntries: [['edit-1', draftOf()]], options: { baseline: { doc: docOf('Hello') } } });
    await advance(0);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await advance(0);
    expect(screen.queryByRole('region', { name: 'Unsaved changes found' })).toBeNull();
    expect(drafts.map.has('edit-1')).toBe(false);
  });

  it('a draft from an older version says so, and restoring it opens the conflict dialog (SAVE-2)', async () => {
    const draft = draftOf({ baseVersion: 0, doc: docOf('Hello from long ago') });
    const { ed, api } = setup({ draftEntries: [['edit-1', draft]], options: { baseline: { doc: docOf('Hello') } } });
    await advance(0);
    const banner = screen.getByRole('region', { name: 'Unsaved changes found' });
    expect(banner).toHaveAttribute('data-kind', 'conflict');
    expect(banner).toHaveTextContent(/saved again/);
    fireEvent.click(within(banner).getByTestId('draft-restore'));
    expect(texts(ed)).toEqual(['Hello from long ago']);
    expect(screen.getByRole('alertdialog', { name: 'This brew was changed somewhere else' })).toBeInTheDocument();
    await advance(10_000);
    expect(api.calls).toHaveLength(0);
  });

  it("says when this browser can't keep drafts (SAVE-11)", async () => {
    const store = memoryDrafts();
    const drafts = Object.assign(store, { persistent: () => false });
    const { ed } = setup({ drafts });
    act(() => typeText(ed, 'x'));
    await advance(0);
    expect(screen.getByTestId('drafts-not-kept')).toHaveTextContent(/can’t be kept on this device/);
  });
});

describe('LocalHistoryDialog', () => {
  it('lists the saved versions and restores one as one undo step', async () => {
    const { ed } = setup();
    act(() => typeText(ed, ' v2'));
    await advance(3000);
    act(() => typeText(ed, ' v3'));
    await advance(3000);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await advance(0);
    const dialog = screen.getByRole('dialog', { name: 'Local history' });
    const items = within(dialog).getAllByTestId('local-history-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('version 3');
    fireEvent.click(within(items[1]!).getByRole('button', { name: /Restore the version from .* \(version 2\)/ }));
    expect(screen.queryByRole('dialog', { name: 'Local history' })).toBeNull();
    expect(texts(ed)).toEqual(['Hello v2']);
    expect(toastStore.getState().toasts[0]).toMatchObject({ title: expect.stringContaining('Restored the version') as unknown });
    act(() => {
      toastStore.getState().toasts[0]!.action!.onAction();
    });
    expect(texts(ed)).toEqual(['Hello v2 v3']);
  });

  it('says so when there is nothing yet', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await advance(0);
    expect(screen.getByTestId('local-history-empty')).toBeInTheDocument();
  });
});

describe('a new brew: the loaded create chain and the draft owner (SAVE-8, SAVE-12)', () => {
  it("takes the chain from CreateChainContext and writes userKey as the drafts' owner", async () => {
    editor = mountEditor(docOf('Hello')).editor;
    const api = fakeApi({ createBrew: () => new Promise(() => {}) });
    const drafts = memoryDrafts();
    const pending = { doc: docOf('Sent'), style: '', snippets: null, meta: null };
    render(
      <CreateChainContext.Provider value={{ key: 'loaded-key', pending, docSchemaVersion: 1 }}>
        <Harness editor={editor} api={api} drafts={drafts} options={{ editId: null, baseVersion: null, userKey: 'user-a' }} />
      </CreateChainContext.Provider>,
    );
    act(() => typeText(editor!, ' there'));
    await advance(3000);
    const [create] = api.calls;
    expect(create).toMatchObject({ method: 'create', options: { idempotencyKey: 'loaded-key' } });
    expect(create!.body).toMatchObject({ doc: docOf('Sent') });
    expect(drafts.map.get('new')).toMatchObject({ ownerId: 'user-a', createKey: 'loaded-key', pending });
  });
});
