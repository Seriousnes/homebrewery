// Authors and invited authors (metadataEditor.jsx renderAuthors and the invitedAuthors TagInput).
//
// The owner sees the owner and authors as chips (authors removable, after a confirmation) and edits
// the invited list with a TagInput; everyone else sees both lists read-only. The draft keeps
// roles: handles the owner adds are 'invited' (the server makes them authors when they first save).
import { useId, useState } from 'react';
import type { BrewAuthorInfo } from '@/api';
import { TagInput } from '@/ported/tagInput/TagInput';
import { ConfirmDialog, IconButton } from '@/ui';
import styles from './MetadataEditor.module.css';
import { inviteProblem, normalizeHandle } from './validations';

export interface AuthorsFieldProps {
  authors: readonly BrewAuthorInfo[];
  editable: boolean;
  onChange: (authors: BrewAuthorInfo[]) => void;
  /** Server error for meta.authors (e.g. an unknown handle). */
  error?: string;
}

const ROLE_LABELS: Record<BrewAuthorInfo['role'], string> = { owner: 'Owner', author: 'Author', invited: 'Invited' };

export function AuthorsField({ authors, editable, onChange, error }: AuthorsFieldProps) {
  const [removing, setRemoving] = useState<string | null>(null);
  const listId = useId();
  const active = authors.filter((a) => a.role !== 'invited');
  const invited = authors.filter((a) => a.role === 'invited').map((a) => a.handle);

  const setInvited = (handles: string[]) => {
    onChange([...active, ...handles.map((handle) => ({ handle, role: 'invited' as const }))]);
  };

  return (
    <div className={styles.authors}>
      <div className={styles.fieldBlock}>
        <span id={listId} className={styles.fieldLabel}>
          Authors
        </span>
        {active.length > 0 ? (
          <ul className={styles.chips} aria-labelledby={listId} data-testid="author-list">
            {active.map((author) => (
              <li key={author.handle} className={styles.chip} data-role={author.role}>
                <a
                  className={styles.chipLink}
                  href={`/user/${encodeURIComponent(author.handle)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${ROLE_LABELS[author.role]}: open ${author.handle}'s page in a new tab`}
                >
                  {author.handle}
                </a>
                <span className={styles.role}>{ROLE_LABELS[author.role]}</span>
                {editable && author.role !== 'owner' ? (
                  <IconButton
                    icon="close"
                    size="sm"
                    tooltip={false}
                    label={`Remove author ${author.handle}`}
                    className={styles.chipRemove}
                    onClick={() => setRemoving(author.handle)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>No authors yet: you will own this brew once it is saved.</p>
        )}
      </div>

      <TagInput
        label="Invited authors"
        itemName="invited author"
        values={invited}
        readOnly={!editable}
        onChange={setInvited}
        normalize={normalizeHandle}
        validate={(raw, values, { index }) =>
          inviteProblem(
            raw,
            [...active.map((a) => a.handle), ...values.filter((_, i) => i !== index)],
          )
        }
        placeholder="Invite by handle"
        hint={
          editable
            ? 'Invited authors can edit the brew once they open its edit link and save. Handles are lower-case.'
            : undefined
        }
        error={error}
        data-testid="invited-authors"
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing ?? ''} as an author?`}
        message="They will lose edit access to this brew, and it will disappear from their user page."
        confirmLabel="Remove author"
        tone="danger"
        onConfirm={() => {
          if (removing !== null) onChange(authors.filter((a) => a.handle !== removing));
        }}
      />
    </div>
  );
}
