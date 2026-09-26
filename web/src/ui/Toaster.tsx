import clsx from 'clsx';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { focusElement } from './internal/focus';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import type { IconName } from './iconPaths';
import { Portal } from './Portal';
import styles from './Toaster.module.css';
import { dismissToast, type Toast, type ToastTone, toastStore, useToasts } from './toastStore';
import hiddenStyles from './VisuallyHidden.module.css';

export interface ToasterProps {
  /** Landmark name of the toast list (default "Notifications"). */
  label?: string;
  /** Key that moves focus to the toasts (default "F8"; false for none). */
  hotkey?: string | false;
}

/** How long an announcement stays in the live region (it is read once when added). */
const ANNOUNCEMENT_MS = 7000;

const TONE_ICON: Record<ToastTone, IconName> = { info: 'info', success: 'success', warning: 'warning', error: 'error' };

/**
 * Renders the toasts (bottom right, above dialogs and never inert) and announces each new one
 * through live regions that exist from the start: errors assertively, the rest politely. Timers
 * pause while the pointer or focus is on the toasts. Mount once, near the app root.
 */
export function Toaster({ label = 'Notifications', hotkey = 'F8' }: ToasterProps) {
  const toasts = useToasts();
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  /** Where focus was before it entered the toasts (F8 or Tab); it goes back there when the last one closes. */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Announce by appending to the live regions (not by rendering), so every raise is read once.
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const seen = new Set(toastStore.getState().toasts.map((t) => `${t.id}:${t.version}`));
    const unsubscribe = toastStore.subscribe((state) => {
      for (const t of state.toasts) {
        const key = `${t.id}:${t.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const region = t.tone === 'error' ? assertiveRef.current : politeRef.current;
        if (!region) continue;
        const line = region.ownerDocument.createElement('div');
        line.textContent = t.description ? `${t.title}. ${t.description}` : t.title;
        region.append(line);
        const timer = setTimeout(() => {
          line.remove();
          timers.delete(timer);
        }, ANNOUNCEMENT_MS);
        timers.add(timer);
      }
    });
    return () => {
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!hotkey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== hotkey || event.ctrlKey || event.metaKey || event.altKey) return;
      const list = listRef.current;
      if (!list) return;
      event.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLElement && !list.contains(active)) returnFocusRef.current = active;
      list.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hotkey]);

  return (
    <Portal kind="toast">
      <div className={hiddenStyles.hidden}>
        <div ref={politeRef} aria-live="polite" aria-relevant="additions" data-testid="toast-live-polite" />
        <div ref={assertiveRef} aria-live="assertive" aria-relevant="additions" data-testid="toast-live-assertive" />
      </div>
      {toasts.length > 0 ? (
        <ToastList toasts={toasts} label={hotkey ? `${label} (${hotkey})` : label} listRef={listRef} returnFocusRef={returnFocusRef} />
      ) : null}
    </Portal>
  );
}

interface ToastListProps {
  toasts: Toast[];
  label: string;
  listRef: RefObject<HTMLElement | null>;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/**
 * The visible list. Mounted only while there are toasts, so its pause state (pointer over it,
 * focus in it) starts fresh each time: browsers send no pointerleave or blur when the element
 * under the pointer or with focus is removed.
 */
function ToastList({ toasts, label, listRef, returnFocusRef }: ToastListProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  // A toast closed from its own buttons: keep keyboard focus in a sensible place.
  const afterDismiss = (hadFocus: boolean) => {
    if (!hadFocus) return;
    if (toastStore.getState().toasts.length > 0) {
      focusElement(listRef.current);
    } else {
      setFocused(false);
      focusElement(returnFocusRef.current);
    }
  };

  return (
    <section
      ref={listRef}
      aria-label={label}
      tabIndex={-1}
      className={styles.viewport}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={(event) => {
        setFocused(true);
        const from = event.relatedTarget;
        if (from instanceof HTMLElement && !event.currentTarget.contains(from)) returnFocusRef.current = from;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <ol className={styles.list}>
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} paused={paused} onDismissed={afterDismiss} />
        ))}
      </ol>
    </section>
  );
}

function ToastView({ toast, paused, onDismissed }: { toast: Toast; paused: boolean; onDismissed: (hadFocus: boolean) => void }) {
  const { id, duration, version } = toast;
  const itemRef = useRef<HTMLLIElement>(null);
  const close = (run?: () => void) => {
    const hadFocus = Boolean(itemRef.current?.contains(document.activeElement));
    run?.();
    dismissToast(id);
    onDismissed(hadFocus);
  };

  useEffect(() => {
    if (duration == null || paused) return;
    const timer = setTimeout(() => dismissToast(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, version, paused]);

  return (
    <li ref={itemRef} className={clsx(styles.toast, styles[toast.tone])} data-toast-id={id} data-tone={toast.tone}>
      <Icon name={TONE_ICON[toast.tone]} size={18} className={styles.icon} />
      <div className={styles.content}>
        <p className={styles.title}>{toast.title}</p>
        {toast.description ? <p className={styles.description}>{toast.description}</p> : null}
        {toast.action ? (
          <div className={styles.actions}>
            <Button
              size="sm"
              onClick={() => close(toast.action?.onAction)}
            >
              {toast.action.label}
            </Button>
          </div>
        ) : null}
      </div>
      <IconButton icon="close" label="Dismiss notification" size="sm" tooltip={false} onClick={() => close()} />
    </li>
  );
}
