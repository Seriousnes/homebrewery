// Toasts: a small global store (zustand, vanilla) so anything — components, the API error policy,
// editor commands — can raise one. <Toaster> renders and announces them.
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  /** Runs, then the toast is dismissed. */
  onAction: () => void;
}

export interface ToastInput {
  /** Reuse an id to replace a toast (it moves to the newest place and is announced again). */
  id?: string;
  title: string;
  description?: string;
  /** Default 'info'. */
  tone?: ToastTone;
  action?: ToastAction;
  /**
   * ms until it closes by itself; null keeps it until dismissed. Default: 5 s; 8 s for errors;
   * null when it has an action (so there is time to reach it by keyboard).
   */
  duration?: number | null;
}

export interface Toast {
  id: string;
  title: string;
  description: string | undefined;
  tone: ToastTone;
  action: ToastAction | undefined;
  duration: number | null;
  createdAt: number;
  /** Bumped when the id is raised again (restarts the timer, announces again). */
  version: number;
}

export interface ToastState {
  toasts: Toast[];
}

export const DEFAULT_TOAST_DURATION_MS = 5000;
export const ERROR_TOAST_DURATION_MS = 8000;
/** Older toasts are dropped beyond this many. */
export const MAX_TOASTS = 5;

export const toastStore = createStore<ToastState>(() => ({ toasts: [] }));

let counter = 0;

function defaultDuration(input: ToastInput): number | null {
  if (input.duration !== undefined) return input.duration;
  if (input.action) return null;
  return input.tone === 'error' ? ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS;
}

/** Show a toast; returns its id. */
export function toast(input: ToastInput): string {
  const id = input.id ?? `hb-toast-${++counter}`;
  toastStore.setState((state) => {
    const previous = state.toasts.find((t) => t.id === id);
    const next: Toast = {
      id,
      title: input.title,
      description: input.description,
      tone: input.tone ?? 'info',
      action: input.action,
      duration: defaultDuration(input),
      createdAt: Date.now(),
      version: (previous?.version ?? 0) + 1,
    };
    const toasts = [...state.toasts.filter((t) => t.id !== id), next];
    return { toasts: toasts.slice(Math.max(0, toasts.length - MAX_TOASTS)) };
  });
  return id;
}

/** Remove a toast. Unknown ids are ignored (subscribers are not notified). */
export function dismissToast(id: string): void {
  toastStore.setState((state) => (state.toasts.some((t) => t.id === id) ? { toasts: state.toasts.filter((t) => t.id !== id) } : state));
}

export function clearToasts(): void {
  toastStore.setState({ toasts: [] });
}

/** The current toasts, oldest first. */
export function useToasts(): Toast[] {
  return useStore(toastStore, (state) => state.toasts);
}
