// "Add image object" (P5.3): asks for the image's URL and puts a positioned image object on the
// page (1 inch from its top-left corner, 300px wide), selected, ready to drag and resize.
import { useState, type FormEvent } from 'react';
import { Button, Dialog, TextField } from '@/ui';
import { isSafeSrc } from '../../schema';
import styles from './objects.module.css';

export interface AddImageObjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with a URL that passed the image source policy (http, https, relative, data:image). */
  onSubmit: (src: string) => void;
}

export function AddImageObjectDialog({ open, onOpenChange, onSubmit }: AddImageObjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add image object" description="The image is placed on the page, outside the text. Drag it or use the arrow keys to move it." data-testid="add-image-object">
      {open ? <AddImageObjectForm onSubmit={onSubmit} onCancel={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function AddImageObjectForm({ onSubmit, onCancel }: { onSubmit: (src: string) => void; onCancel: () => void }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = src.trim();
    if (!value) {
      setError('Enter the image’s address.');
      return;
    }
    if (!isSafeSrc(value)) {
      setError('Use an http or https address (or a data:image URL).');
      return;
    }
    onSubmit(value);
    onCancel();
  };
  return (
    <form onSubmit={submit} noValidate>
      <TextField
        label="Image URL"
        type="url"
        value={src}
        error={error}
        autoComplete="off"
        data-autofocus=""
        onChange={(e) => {
          setSrc(e.target.value);
          setError(undefined);
        }}
        data-testid="image-object-url"
      />
      <div className={styles.actions}>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" data-testid="image-object-submit">
          Add image
        </Button>
      </div>
    </form>
  );
}
