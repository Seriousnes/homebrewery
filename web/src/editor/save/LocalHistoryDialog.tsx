// Local history (plan §9 snapshots): the brew's five rolling versions on this device. Restoring
// one replaces the document as a single undo step, and a toast offers Undo.
import { useEffect, useState } from 'react';
import { Button, Dialog, Spinner, toast } from '@/ui';
import styles from './save.module.css';
import type { Snapshot } from './snapshots';
import { formatRelative, formatSavedAt } from './statusText';
import type { UseAutosaveResult } from './useAutosave';

export interface LocalHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autosave: UseAutosaveResult;
}

export function LocalHistoryDialog({ open, onOpenChange, autosave }: LocalHistoryDialogProps) {
  return open ? <LocalHistoryContent onOpenChange={onOpenChange} autosave={autosave} /> : null;
}

function LocalHistoryContent({ onOpenChange, autosave }: Omit<LocalHistoryDialogProps, 'open'>) {
  const [items, setItems] = useState<Snapshot[] | null>(null);
  const { listSnapshots, saveCount } = autosave;

  useEffect(() => {
    let cancelled = false;
    void listSnapshots().then((list) => {
      if (!cancelled) setItems(list);
    });
    return () => {
      cancelled = true;
    };
  }, [listSnapshots, saveCount]);

  const restore = (snapshot: Snapshot) => {
    const when = formatSavedAt(snapshot.savedAt);
    if (!autosave.restoreSnapshot(snapshot)) {
      toast({ title: "Couldn't restore that version", tone: 'error' });
      return;
    }
    onOpenChange(false);
    const editor = autosave.editor;
    toast({
      title: `Restored the version from ${when}`,
      description: 'Undo (Ctrl+Z) goes back to what you had.',
      tone: 'success',
      action: editor ? { label: 'Undo', onAction: () => editor.commands.undo() } : undefined,
    });
  };

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Local history"
      description="Earlier saved versions of this brew, kept on this device (up to five, thinning out with age)."
      data-testid="local-history"
    >
      {items === null ? (
        <Spinner label="Loading local history" />
      ) : items.length === 0 ? (
        <p className={styles.empty} data-testid="local-history-empty">
          No versions yet. They are recorded as this brew saves.
        </p>
      ) : (
        <ol className={styles.snapshots} aria-label="Versions, newest first">
          {items.map((snapshot) => {
            const when = formatSavedAt(snapshot.savedAt);
            const name = `the version from ${when}${snapshot.version !== null ? ` (version ${snapshot.version})` : ''}`;
            return (
              <li key={snapshot.slot} className={styles.snapshot} data-testid="local-history-item">
                <div className={styles.snapshotText}>
                  <span className={styles.snapshotTime}>{when}</span>{' '}
                  <span className={styles.snapshotMeta}>
                    {formatRelative(snapshot.savedAt)} · {snapshot.title}
                    {snapshot.version !== null ? ` · version ${snapshot.version}` : ''}
                  </span>
                </div>
                <Button size="sm" onClick={() => restore(snapshot)} aria-label={`Restore ${name}`}>
                  Restore
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </Dialog>
  );
}
