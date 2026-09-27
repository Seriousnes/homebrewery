// MetadataEditor, ported from legacy/client/homebrew/editor/metadataEditor/metadataEditor.jsx onto
// the UI kit: title, description, thumbnail (with preview), tags, language, theme, authors and
// invited authors, publish, lock information (request a review) and delete.
//
// The form is controlled: `draft` comes from the parent, and every accepted edit calls onChange
// with the field, the whole new draft and the save payload (SaveBrewRequest.meta). Text that
// breaks a rule stays in its box with the upstream message and is not reported, as upstream did.
// Server validation errors (meta.* keys of a 400) show on their fields until that field is edited.
//
// Dropped from upstream: the renderer choice (V3 only) and the double confirm() before deleting.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BrewLockInfo, ThemeList } from '@/api';
import { Combobox } from '@/ported/tagInput/Combobox';
import type { ComboboxOption } from '@/ported/tagInput/comboboxModel';
import { normalizeTag, TAG_PATTERN, tagProblem, tagType } from '@/ported/tagInput/normalizeTag';
import { TagInput } from '@/ported/tagInput/TagInput';
import { TAG_SUGGESTIONS } from '@/ported/tagInput/tagSuggestions';
import { Button, ConfirmDialog, Icon, IconButton, Switch, TextArea, TextField } from '@/ui';
import { AuthorsField } from './AuthorsField';
import { languageOptions } from './languages';
import styles from './MetadataEditor.module.css';
import { canManageAuthors, metaFieldErrors, metaInputFromDraft, type MetadataBrew, type MetadataChange, type MetaDraft, type MetaField } from './metaDraft';
import { findThemeByText, themeChoices, themeLabel, themeOptions } from './themeOptions';
import defaultThumbnail from './thumbnail.png';
import { ERROR_DELAY_MS, MAX_DESCRIPTION, parseShareReference, validateField, type ValidatedField } from './validations';

export interface MetadataEditorProps {
  brew: MetadataBrew;
  draft: MetaDraft;
  onChange: (change: MetadataChange) => void;
  /** GET /api/themes; undefined while loading or after an error. */
  themes?: ThemeList;
  themesState?: 'loading' | 'error' | 'ready';
  onRetryThemes?: () => void;
  /** The error of the last save (an ApiError with meta.* field errors), if any. */
  serverError?: unknown;
  /** This site's origin, for share URLs typed into the theme field (default location.origin). */
  baseUrl?: string;
  /** Deletes the brew (or removes the caller as an author); the button is hidden without it. */
  onDelete?: () => Promise<unknown>;
  /** Requests a lock review; the button is hidden without it. */
  onRequestReview?: () => Promise<BrewLockInfo>;
  /** The lock to show (default brew.lock), e.g. after a review request. */
  lock?: BrewLockInfo | null;
  /**
   * A local brew (issue #4): kept in this browser only. Authors and publishing need the cloud, so
   * those sections are replaced by a note.
   */
  local?: boolean;
}

const TAG_OPTIONS: ComboboxOption[] = TAG_SUGGESTIONS.map((tag) => {
  const tone = tagType(tag);
  return tone ? { value: tag, label: tag, tone } : { value: tag, label: tag };
});

const EMPTY_FIELDS: ReadonlySet<MetaField> = new Set();

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

export function MetadataEditor({
  brew,
  draft,
  onChange,
  themes,
  themesState = themes ? 'ready' : 'loading',
  onRetryThemes,
  serverError,
  baseUrl = typeof location === 'undefined' ? '' : location.origin,
  onDelete,
  onRequestReview,
  lock = brew.lock,
  local = false,
}: MetadataEditorProps) {
  const ids = useId();
  const context = { baseUrl };

  // Text as typed (may break a rule); null = show the draft's value.
  const [text, setText] = useState<Partial<Record<ValidatedField, string>>>({});
  const [problems, setProblems] = useState<Partial<Record<MetaField, string>>>({});
  const [showThumbnail, setShowThumbnail] = useState(true);
  const [thumbnailFailed, setThumbnailFailed] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Server errors stay on a field until it is edited (per error object).
  const server = useMemo(() => metaFieldErrors(serverError), [serverError]);
  const [edited, setEdited] = useState<{ source: unknown; fields: Set<MetaField> }>({ source: serverError, fields: new Set() });
  const editedFields: ReadonlySet<MetaField> = edited.source === serverError ? edited.fields : EMPTY_FIELDS;
  const markEdited = (field: MetaField) =>
    setEdited((prev) => ({ source: serverError, fields: new Set(prev.source === serverError ? prev.fields : []).add(field) }));
  const errorOf = (field: MetaField): string | undefined => problems[field] ?? (editedFields.has(field) ? undefined : server.fields[field]);

  const choices = useMemo(() => themeChoices(themes, { excludeShareId: brew.shareId }), [themes, brew.shareId]);
  const themeOpts = useMemo(() => themeOptions(choices), [choices]);
  const langOpts = useMemo(() => languageOptions(), []);

  const emit = (field: MetaField, patch: Partial<MetaDraft>) => {
    const next: MetaDraft = { ...draft, ...patch };
    onChange({ field, draft: next, meta: metaInputFromDraft(next, brew) });
  };

  // Rule messages appear once typing pauses (upstream debounced them by 300 ms too); fixing
  // the text clears them at once.
  const timers = useRef(new Map<MetaField, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);
  const setProblem = (field: MetaField, message: string | undefined, delayMs = 0) => {
    const apply = () =>
      setProblems((prev) => {
        if (prev[field] === message) return prev;
        const next = { ...prev };
        if (message === undefined) delete next[field];
        else next[field] = message;
        return next;
      });
    clearTimeout(timers.current.get(field));
    timers.current.delete(field);
    if (message === undefined || delayMs <= 0) apply();
    else timers.current.set(field, setTimeout(apply, delayMs));
  };

  /** A text field changed: keep the text; report it when every rule passes. */
  const editText = (field: ValidatedField & MetaField, value: string) => {
    markEdited(field);
    setText((prev) => ({ ...prev, [field]: value }));
    const messages = validateField(field, value, context);
    setProblem(field, messages.length > 0 ? messages.join(' ') : undefined, ERROR_DELAY_MS);
    if (messages.length === 0) emit(field, { [field]: value });
  };
  /** Leaving a text field shows its rule message at once. */
  const flushText = (field: ValidatedField & MetaField) => {
    const value = text[field];
    if (value === undefined) return;
    const messages = validateField(field, value, context);
    setProblem(field, messages.length > 0 ? messages.join(' ') : undefined);
  };

  const shown = (field: ValidatedField, value: string) => text[field] ?? value;

  // Theme: the box shows the current theme's name until the user types.
  const themeText = text.theme ?? themeLabel(draft.theme, choices);
  const chooseTheme = (id: string) => {
    markEdited('theme');
    setText((prev) => {
      const next = { ...prev };
      delete next.theme;
      return next;
    });
    setProblem('theme', undefined);
    if (id !== draft.theme) emit('theme', { theme: id });
  };
  const commitThemeText = (value: string) => {
    if (text.theme === undefined) return; // not typed: nothing to do
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === themeLabel(draft.theme, choices)) {
      chooseTheme(draft.theme);
      return;
    }
    const listed = findThemeByText(trimmed, choices);
    if (listed) {
      chooseTheme(listed.id);
      return;
    }
    const messages = validateField('theme', trimmed, context);
    const id = parseShareReference(trimmed, baseUrl);
    if (messages.length > 0 || id === null) setProblem('theme', messages.join(' ') || 'Must be a valid Share URL or a 12-character ID.');
    else chooseTheme(id);
  };

  const thumbnail = draft.thumbnailUrl.trim();
  const activeAuthors = brew.authors.filter((a) => a.role !== 'invited');
  const soleAuthor = brew.role !== 'invited' && activeAuthors.length <= 1;
  const otherErrors = editedFields.size > 0 ? [] : server.other;

  return (
    <div className={styles.editor}>
      {otherErrors.length > 0 ? (
        <div className={styles.alert} role="alert">
          <Icon name="error" size={16} />
          <div>{otherErrors.join(' ')}</div>
        </div>
      ) : null}

      {lock ? (
        <section className={styles.lock} aria-labelledby={`${ids}-lock`} data-testid="lock-info">
          <h3 id={`${ids}-lock`} className={styles.lockTitle}>
            <Icon name="lock" size={16} />
            This brew is locked
          </h3>
          <p className={styles.lockText}>
            An administrator locked this brew (code {lock.code}, {formatDate(lock.applied)}). Only its authors can open it, in
            the editor, until the lock is removed.
          </p>
          <p className={styles.lockReason}>
            <strong>Reason: </strong>
            {lock.message || 'No reason was given.'}
          </p>
          {lock.reviewRequested ? (
            <p className={styles.lockText} data-testid="review-requested">
              Review requested on {formatDate(lock.reviewRequested)}. An administrator will look at it.
            </p>
          ) : onRequestReview ? (
            <div className={styles.lockActions}>
              <p className={styles.lockText}>Once you have fixed the problem, ask the administrators to review the brew.</p>
              <Button
                icon="unlock"
                loading={reviewPending}
                onClick={() => {
                  setReviewPending(true);
                  setReviewError(null);
                  onRequestReview()
                    .catch(() => setReviewError("Couldn't request a review. Try again."))
                    .finally(() => setReviewPending(false));
                }}
              >
                Request review
              </Button>
              {reviewError ? (
                <p className={styles.errorText} role="alert">
                  {reviewError}
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby={`${ids}-brew`}>
        <h3 id={`${ids}-brew`} className={styles.sectionTitle}>
          Brew
        </h3>
        <TextField
          label="Title"
          value={shown('title', draft.title)}
          onChange={(e) => editText('title', e.target.value)}
          onBlur={() => flushText('title')}
          error={errorOf('title')}
          hint="Leave it empty to use the first heading of the brew."
          data-autofocus=""
          data-testid="meta-title"
        />
        <div className={styles.row}>
          <div className={styles.column}>
            <TextArea
              label="Description"
              value={shown('description', draft.description)}
              onChange={(e) => editText('description', e.target.value)}
              onBlur={() => flushText('description')}
              error={errorOf('description')}
              hint={`${shown('description', draft.description).length} / ${MAX_DESCRIPTION} characters`}
              rows={4}
              data-testid="meta-description"
            />
            <div className={styles.thumbnailRow}>
              <TextField
                label="Thumbnail"
                type="url"
                inputMode="url"
                placeholder="https://my.thumbnail.url"
                value={shown('thumbnailUrl', draft.thumbnailUrl)}
                onChange={(e) => editText('thumbnailUrl', e.target.value)}
                onBlur={() => flushText('thumbnailUrl')}
                error={errorOf('thumbnailUrl')}
                hint="Shown in brew lists and link previews."
                className={styles.grow}
                data-testid="meta-thumbnail"
              />
              <IconButton
                icon={showThumbnail ? 'eyeOff' : 'eye'}
                label={showThumbnail ? 'Hide thumbnail preview' : 'Show thumbnail preview'}
                pressed={showThumbnail}
                className={styles.thumbnailToggle}
                onClick={() => setShowThumbnail((v) => !v)}
              />
            </div>
          </div>
          {showThumbnail ? (
            <figure className={styles.thumbnail}>
              {thumbnail && thumbnailFailed === thumbnail ? (
                <div className={styles.thumbnailMissing}>Couldn&apos;t load this image.</div>
              ) : (
                <img
                  src={thumbnail || defaultThumbnail}
                  alt={thumbnail ? 'Thumbnail preview' : 'Default thumbnail'}
                  onError={() => setThumbnailFailed(thumbnail)}
                  data-testid="thumbnail-preview"
                />
              )}
            </figure>
          ) : null}
        </div>

        <TagInput
          label="Tags"
          itemName="tag"
          values={draft.tags}
          onChange={(tags) => {
            markEdited('tags');
            emit('tags', { tags });
          }}
          suggestions={TAG_OPTIONS}
          validate={(raw, values, { index, suggested }) =>
            tagProblem(raw, values, { pattern: suggested ? null : TAG_PATTERN, ...(index === undefined ? {} : { ignoreIndex: index }) })
          }
          normalize={(raw) => normalizeTag(raw.trim())}
          toneOf={(tag) => tagType(tag) ?? undefined}
          placeholder="Add a tag"
          hint='You may start tags with "type", "system", "group" or "meta" followed by a colon ":"; these are coloured on your user page. Tag a brew "meta:theme" to use it as a theme.'
          error={errorOf('tags')}
          data-testid="meta-tags"
        />

        <div className={styles.row}>
          <Combobox
            label="Language"
            value={shown('lang', draft.lang)}
            onValueChange={(value) => editText('lang', value)}
            options={langOpts}
            filter="startsWith"
            currentValue={draft.lang}
            onSelect={(option) => editText('lang', option.value)}
            onBlur={() => flushText('lang')}
            placeholder="en"
            hint="Sets the HTML lang of your brew. May affect hyphenation or spellcheck."
            error={errorOf('lang')}
            className={styles.language}
            data-testid="meta-lang"
          />
          <Combobox
            label="Theme"
            value={themeText}
            onValueChange={(value) => {
              markEdited('theme');
              setText((prev) => ({ ...prev, theme: value }));
              setProblem('theme', undefined);
            }}
            options={themeOpts}
            currentValue={draft.theme}
            onSelect={(option) => chooseTheme(option.value)}
            onCommit={commitThemeText}
            onBlur={(e) => commitThemeText(e.target.value)}
            emptyMessage={themesState === 'loading' ? 'Loading themes…' : 'No matching theme. Paste a Share URL or ID to use any theme brew.'}
            hint={
              themesState === 'error' ? (
                <span className={styles.inlineHint}>
                  Couldn&apos;t load the theme list; you can still paste a Share URL or ID.
                  {onRetryThemes ? (
                    <Button size="sm" variant="ghost" onClick={onRetryThemes}>
                      Retry
                    </Button>
                  ) : null}
                </span>
              ) : (
                'Pick a theme (built-in themes and brews tagged "meta:theme"), or paste the Share URL or Share ID of a theme brew.'
              )
            }
            error={errorOf('theme')}
            className={styles.theme}
            data-testid="meta-theme"
          />
        </div>
      </section>

      {local ? (
        <section className={styles.section} aria-labelledby={`${ids}-local`} data-testid="meta-local-note">
          <h3 id={`${ids}-local`} className={styles.sectionTitle}>
            On this device
          </h3>
          <p className={styles.muted}>
            This brew is kept in this browser only. Sign in and upload it to your account to publish it, share it or add authors.
          </p>
        </section>
      ) : (
        <>
          <section className={styles.section} aria-labelledby={`${ids}-authors`}>
            <h3 id={`${ids}-authors`} className={styles.sectionTitle}>
              Authors
            </h3>
            <AuthorsField
              authors={draft.authors}
              editable={canManageAuthors(brew.role)}
              onChange={(authors) => {
                markEdited('authors');
                emit('authors', { authors });
              }}
              error={errorOf('authors')}
            />
          </section>

          <section className={styles.section} aria-labelledby={`${ids}-privacy`}>
            <h3 id={`${ids}-privacy`} className={styles.sectionTitle}>
              Privacy
            </h3>
            <Switch
              label="Published"
              checked={draft.published}
              onChange={(e) => {
                markEdited('published');
                emit('published', { published: e.target.checked });
              }}
              hint="Published brews are searchable in the Vault and listed on your user page. Unpublished brews are not, but anyone with the share link can still read them. You can unpublish at any time."
              data-testid="meta-published"
            />
            {errorOf('published') ? <p className={styles.errorText}>{errorOf('published')}</p> : null}
          </section>
        </>
      )}

      {onDelete && brew.editId ? (
        <section className={styles.section} aria-labelledby={`${ids}-delete`}>
          <h3 id={`${ids}-delete`} className={styles.sectionTitle}>
            Delete
          </h3>
          <p className={styles.muted}>
            {soleAuthor
              ? 'You are the only author: deleting removes the brew for good.'
              : 'Other authors keep the brew; deleting removes it from your collection.'}
          </p>
          <div>
            <Button variant="danger" icon="trash" onClick={() => setDeleting(true)} data-testid="delete-brew">
              {soleAuthor ? 'Delete brew' : 'Remove from my brews'}
            </Button>
          </div>
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            tone="danger"
            title={soleAuthor ? 'Delete this brew?' : 'Remove this brew from your collection?'}
            message={
              soleAuthor
                ? 'Because you are its only author, the brew will be deleted permanently. You will not be able to recover it.'
                : 'You will lose edit access to this brew. The other authors can still open and edit it.'
            }
            confirmLabel={soleAuthor ? 'Delete permanently' : 'Remove me'}
            onConfirm={onDelete}
          />
        </section>
      ) : null}
    </div>
  );
}
