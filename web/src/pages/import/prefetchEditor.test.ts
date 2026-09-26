import { afterEach, describe, expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ edit: 0, editor: 0 }));
vi.mock('@/pages/edit', () => {
  loaded.edit++;
  return { default: () => null };
});
vi.mock('@/editor/EditorApp/EditorApp', () => {
  loaded.editor++;
  return { EditorApp: () => null };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('prefetchEditor', () => {
  it('loads the editor once, when the browser is idle', async () => {
    const idle: Array<() => void> = [];
    const requestIdle = vi.fn((run: () => void, _options?: IdleRequestOptions) => idle.push(run));
    vi.stubGlobal('requestIdleCallback', requestIdle);
    const { prefetchEditor } = await import('./prefetchEditor');
    prefetchEditor();
    prefetchEditor();
    expect(requestIdle).toHaveBeenCalledTimes(1);
    expect(requestIdle.mock.calls[0]?.[1]).toEqual({ timeout: 3000 });
    expect(loaded).toEqual({ edit: 0, editor: 0 });
    idle[0]!();
    await vi.waitFor(() => expect(loaded).toEqual({ edit: 1, editor: 1 }));
  });
});
