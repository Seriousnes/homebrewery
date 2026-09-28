import { QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApiError, type ErrorToast, fetchThemes, queryKeys, saveBrew } from '@/api';
import { jsonResponse, mockApi, problemResponse } from '@/api/testing';
import { clearToasts, toastStore } from '@/ui/toastStore';
import { createQueryClient } from './queryClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearToasts();
});

function setup(options: Parameters<typeof createQueryClient>[0] = {}) {
  const toasts: ErrorToast[] = [];
  const onSignIn = vi.fn();
  const client = createQueryClient({ notify: (t) => toasts.push(t), onSignIn, ...options });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper, toasts, onSignIn };
}

describe('createQueryClient error policy', () => {
  it('toasts a failed query once (after retries) with a Retry that refetches', async () => {
    const { wrapper, toasts } = setup();
    let calls = 0;
    mockApi(() => {
      calls++;
      return calls <= 3 ? problemResponse(503, { title: 'Service Unavailable' }) : jsonResponse({ static: [], user: [] });
    });
    const hook = renderHook(() => useQuery({ queryKey: ['t'], queryFn: () => fetchThemes(), retryDelay: 0 }), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(calls).toBe(3); // first try + 2 retries
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: 'error', title: "Couldn't load data", action: { label: 'Retry' } });
    act(() => toasts[0]?.action?.onAction());
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  });

  it('does not retry or toast a 404; the page renders it', async () => {
    const { wrapper, toasts } = setup();
    let calls = 0;
    mockApi(() => {
      calls++;
      return problemResponse(404, { title: 'Brew not found' });
    });
    const hook = renderHook(() => useQuery({ queryKey: ['b'], queryFn: () => fetchThemes() }), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(calls).toBe(1);
    expect(toasts).toHaveLength(0);
  });

  it('on 401 clears me and asks for sign-in', async () => {
    const { wrapper, client, onSignIn, toasts } = setup();
    client.setQueryData(queryKeys.account.me(), { id: 'u', handle: 'a', email: null, roles: [] });
    mockApi(() => problemResponse(401));
    const hook = renderHook(() => useQuery({ queryKey: ['x'], queryFn: () => fetchThemes() }), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect((onSignIn.mock.calls[0]![0] as ApiError).status).toBe(401);
    expect(client.getQueryData(queryKeys.account.me())).toBeNull();
    expect(toasts).toHaveLength(0);
  });

  it('leaves a save conflict to the caller and re-executes a failed mutation from its toast', async () => {
    const { wrapper, toasts } = setup();
    mockApi(() => jsonResponse({ serverVersion: 5 }, 409));
    const conflict = renderHook(() => useMutation({ mutationFn: () => saveBrew('e', { baseVersion: 1, doc: {} }) }), { wrapper });
    await act(() => conflict.result.current.mutateAsync().catch(() => undefined));
    await waitFor(() => expect(conflict.result.current.error).toMatchObject({ status: 409, serverVersion: 5 }));
    expect(toasts).toHaveLength(0);

    let calls = 0;
    mockApi(() => (++calls === 1 ? problemResponse(500) : jsonResponse({ version: 2, updatedAt: '', title: '', pageCount: 1, authors: [] })));
    const save = renderHook(() => useMutation({ mutationFn: () => saveBrew('e', { baseVersion: 1, doc: {} }), meta: { errorTitle: 'Save failed' } }), { wrapper });
    await act(() => save.result.current.mutateAsync().catch(() => undefined));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: 'Save failed', action: { label: 'Retry' } });
    act(() => toasts[0]?.action?.onAction());
    await waitFor(() => expect(save.result.current.isSuccess).toBe(true));
    expect(calls).toBe(2);
  });

  it('meta errorPolicy manual silences the policy', async () => {
    const { wrapper, toasts, onSignIn } = setup();
    mockApi(() => problemResponse(401));
    const hook = renderHook(() => useQuery({ queryKey: ['m'], queryFn: () => fetchThemes(), meta: { errorPolicy: 'manual' } }), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(onSignIn).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(0);
  });

  it('removes the error toast of a query that later succeeds', async () => {
    const client = createQueryClient({ onSignIn: () => undefined });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    let calls = 0;
    mockApi(() => (++calls === 1 ? problemResponse(500) : jsonResponse({ static: [], user: [] })));
    const hook = renderHook(() => useQuery({ queryKey: ['recover'], queryFn: () => fetchThemes(), retry: false }), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(toastStore.getState().toasts).toHaveLength(1);
    await act(() => hook.result.current.refetch());
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(toastStore.getState().toasts).toHaveLength(0);
  });

  it('uses the UI kit toast store by default', async () => {
    const client = createQueryClient({ onSignIn: () => undefined });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    mockApi(() => problemResponse(400, { title: 'Bad sort' }));
    const hook = renderHook(() => useQuery({ queryKey: ['d'], queryFn: () => fetchThemes() }), { wrapper });
    await waitFor(() => expect(hook.result.current.isError).toBe(true));
    expect(toastStore.getState().toasts).toHaveLength(1);
    expect(toastStore.getState().toasts[0]).toMatchObject({ tone: 'error', description: 'Bad sort' });
  });
});
