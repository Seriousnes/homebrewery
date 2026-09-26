// State of the brew snippets editor: the list, the selected snippet and an undo history of its
// own. It lives as long as the editor page (EditorApp), so closing the Snippets panel keeps both.
//
// Every edit is one undo step. Typing merges into the step before it while it continues (same
// field of the same snippet, less than MERGE_MS since the last keystroke, nothing else in between),
// like CodeMirror's history. Undo and redo select the snippet they changed.
//
// Value flow: the store starts from the brew's stored snippets (any shape) and reports every change
// as the stored form (storedSnippets: [{ group?, name, gen }] or null) through onChange. Until the
// first edit (or after undoing back to the start) it reports the value it was given, unchanged, so
// an untouched brew never looks edited. A value from outside (the saved version loaded again, a
// restored draft or snapshot) replaces the list and clears the history (sync). What the store
// reported itself is recognised by identity (a render that lags behind typing changes nothing);
// null or a string is compared with the current value.
//
// Size: an edit that would take the stored JSON over the server's limit (MAX_SNIPPETS_JSON, as the
// server measures it) is refused with a notice; edits that make it smaller are always allowed.
import { MAX_SNIPPETS_JSON, editableUserSnippets, serverJsonLength, storedSnippet, storedSnippets, type UserSnippetFields } from '@/editor/snippets/storedSnippets';
import type { EditableSnippet } from './snippetsModel';

export interface SnippetsEditorState {
  readonly snippets: readonly EditableSnippet[];
  /** Key of the snippet being edited, or null. */
  readonly selected: string | null;
}

export interface SnippetsNotice {
  /** Changes with every notice (announce it again even when the text repeats). */
  readonly id: number;
  readonly tone: 'info' | 'error';
  readonly message: string;
}

export interface SnippetsEditorSnapshot extends SnippetsEditorState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Length of the stored JSON as the server measures it. */
  readonly size: number;
  readonly maxSize: number;
  readonly notice: SnippetsNotice | null;
}

export interface SnippetsEditorOptions {
  /** Called with the new stored value after every change of the snippets. */
  onChange?: (value: unknown) => void;
  /** Default MAX_SNIPPETS_JSON. */
  maxSize?: number;
  /** Typing within this many ms merges into one undo step (default MERGE_MS). */
  mergeMs?: number;
  /** Undo steps kept (default MAX_STEPS). */
  maxSteps?: number;
  now?: () => number;
}

export const MERGE_MS = 1000;
export const MAX_STEPS = 200;

export const SIZE_REFUSED = 'Not changed: a brew’s snippets can’t take more than 2 MB.';

interface Step {
  before: SnippetsEditorState;
  after: SnippetsEditorState;
  /** Steps with the same merge key merge while typing continues; null never merges. */
  merge: string | null;
  at: number;
}

type Field = 'name' | 'group' | 'gen';

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

export class SnippetsEditorStore {
  private state: SnippetsEditorState;
  private past: Step[] = [];
  private future: Step[] = [];
  private snapshot: SnippetsEditorSnapshot;
  private listeners = new Set<() => void>();
  private nextKey = 0;
  private noticeId = 0;
  private notice: SnippetsNotice | null = null;
  /** The value the store was given, and the list made from it: reported while nothing changed. */
  private initialValue: unknown;
  private initialSnippets: readonly EditableSnippet[];
  private lastValue: { snippets: readonly EditableSnippet[]; value: unknown } | null = null;
  /** Objects this store reported (or was given): a `sync` with one of them changes nothing. */
  private reported = new WeakSet<object>();
  private readonly sizes = new WeakMap<EditableSnippet, number>();
  private onChange: ((value: unknown) => void) | undefined;
  private readonly maxSize: number;
  private readonly mergeMs: number;
  private readonly maxSteps: number;
  private readonly now: () => number;

  constructor(value: unknown, options: SnippetsEditorOptions = {}) {
    this.onChange = options.onChange;
    this.maxSize = options.maxSize ?? MAX_SNIPPETS_JSON;
    this.mergeMs = options.mergeMs ?? MERGE_MS;
    this.maxSteps = options.maxSteps ?? MAX_STEPS;
    this.now = options.now ?? (() => Date.now());
    this.initialValue = value;
    this.state = this.stateFrom(value);
    this.initialSnippets = this.state.snippets;
    this.remember(value);
    this.snapshot = this.makeSnapshot();
  }

  // ─── Store protocol (useSyncExternalStore) ─────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SnippetsEditorSnapshot => this.snapshot;

  setOnChange(onChange: ((value: unknown) => void) | undefined): void {
    this.onChange = onChange;
  }

  /** The value to store now (what onChange last reported, or the initial value). */
  value(): unknown {
    return this.valueOf(this.state.snippets);
  }

  /**
   * A value from outside. The store's current value and objects it reported (a render catching
   * up with typing) change nothing; any other value replaces the list and clears the history.
   */
  sync(value: unknown): void {
    if (value === this.value() || (isObject(value) && this.reported.has(value))) return;
    this.initialValue = value;
    this.state = this.stateFrom(value);
    this.initialSnippets = this.state.snippets;
    this.remember(value);
    this.past = [];
    this.future = [];
    this.notice = null;
    this.publish();
  }

  // ─── Reading ───────────────────────────────────────────────────────────────────────────────

  get(key: string | null): EditableSnippet | null {
    return key === null ? null : (this.state.snippets.find((s) => s.key === key) ?? null);
  }

  /** Whether changing `key`'s fields to `patch` keeps the snippets within the size limit. */
  fits(key: string, patch: Partial<UserSnippetFields>): boolean {
    const next = this.state.snippets.map((s) => (s.key === key ? { ...s, ...patch } : s));
    return this.fitsList(next);
  }

  // ─── Edits (one undo step each; false = refused or nothing to do) ──────────────────────────

  select(key: string | null): void {
    if (key === this.state.selected || (key !== null && !this.get(key))) return;
    this.breakMerge();
    this.state = { ...this.state, selected: key };
    this.publish();
  }

  /** Adds a snippet after the selected one (or at the end) and selects it. Returns its key. */
  add(fields: UserSnippetFields): string | null {
    const snippet = this.create(fields);
    const at = this.indexOf(this.state.selected);
    const snippets = [...this.state.snippets];
    snippets.splice(at < 0 ? snippets.length : at + 1, 0, snippet);
    return this.commit({ snippets, selected: snippet.key }, null) ? snippet.key : null;
  }

  /** A copy of `key` right after it, named `name`, selected. Returns its key. */
  duplicate(key: string, name: string): string | null {
    const at = this.indexOf(key);
    if (at < 0) return null;
    const original = this.state.snippets[at]!;
    const copy = this.create({ group: original.group, name, gen: original.gen });
    const snippets = [...this.state.snippets];
    snippets.splice(at + 1, 0, copy);
    return this.commit({ snippets, selected: copy.key }, null) ? copy.key : null;
  }

  /** Deletes `key`; `select` is what gets selected next (a neighbour, or null). */
  remove(key: string, select: string | null): boolean {
    if (this.indexOf(key) < 0) return false;
    const snippets = this.state.snippets.filter((s) => s.key !== key);
    const selected = select !== null && select !== key && snippets.some((s) => s.key === select) ? select : null;
    return this.commit({ snippets, selected }, null);
  }

  /** Changes one field of `key`. Typing merges (see the top of the file). */
  update(key: string, field: Field, value: string, options: { merge?: boolean } = {}): boolean {
    const at = this.indexOf(key);
    if (at < 0) return false;
    const old = this.state.snippets[at]!;
    if (old[field] === value) return true;
    const snippets = [...this.state.snippets];
    snippets[at] = { ...old, [field]: value };
    return this.commit({ snippets, selected: key }, options.merge === false ? null : `${field}:${key}`);
  }

  /** Swaps two snippets' places in the list (moving one past its neighbour). */
  swap(a: string, b: string): boolean {
    const i = this.indexOf(a);
    const j = this.indexOf(b);
    if (i < 0 || j < 0 || i === j) return false;
    const snippets = [...this.state.snippets];
    [snippets[i], snippets[j]] = [snippets[j]!, snippets[i]!];
    return this.commit({ snippets, selected: a }, null);
  }

  /**
   * Adds `list` after the others ('append') or instead of them ('replace'), and selects the first
   * one. Returns the new keys ([] when refused or empty).
   */
  importSnippets(list: readonly UserSnippetFields[], mode: 'append' | 'replace'): string[] {
    if (!list.length) return [];
    const added = list.map((s) => this.create(s));
    const snippets = mode === 'append' ? [...this.state.snippets, ...added] : added;
    return this.commit({ snippets, selected: added[0]!.key }, null) ? added.map((s) => s.key) : [];
  }

  undo(): boolean {
    const step = this.past.pop();
    if (!step) return false;
    this.future.push(step);
    this.apply(step.before);
    return true;
  }

  redo(): boolean {
    const step = this.future.pop();
    if (!step) return false;
    this.past.push(step);
    this.apply(step.after);
    return true;
  }

  /** The next edit starts a new undo step (focus left a field, another snippet was selected). */
  breakMerge(): void {
    const top = this.past.at(-1);
    if (top) top.merge = null;
  }

  /** Shows a message in the editor's status (and its live region). */
  announce(message: string, tone: SnippetsNotice['tone'] = 'info'): void {
    this.notice = { id: ++this.noticeId, tone, message };
    this.publish();
  }

  /** Refuses an edit for its size (the body editor's filter calls this). */
  refuseSize(): void {
    this.announce(SIZE_REFUSED, 'error');
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────────────────

  private stateFrom(value: unknown): SnippetsEditorState {
    const snippets = editableUserSnippets(value).map((s) => this.create(s));
    return { snippets, selected: snippets[0]?.key ?? null };
  }

  private create(fields: UserSnippetFields): EditableSnippet {
    return { key: `s${++this.nextKey}`, group: fields.group, name: fields.name, gen: fields.gen };
  }

  private indexOf(key: string | null): number {
    return key === null ? -1 : this.state.snippets.findIndex((s) => s.key === key);
  }

  private sizeOfSnippet(snippet: EditableSnippet): number {
    let size = this.sizes.get(snippet);
    if (size === undefined) {
      size = serverJsonLength(storedSnippet(snippet));
      this.sizes.set(snippet, size);
    }
    return size;
  }

  /** The stored JSON's length for `snippets` (null when there are none). */
  private sizeOf(snippets: readonly EditableSnippet[]): number {
    if (!snippets.length) return 4;
    let size = 2 + snippets.length - 1;
    for (const s of snippets) size += this.sizeOfSnippet(s);
    return size;
  }

  private fitsList(snippets: readonly EditableSnippet[]): boolean {
    const size = this.sizeOf(snippets);
    return size <= this.maxSize || size <= this.sizeOf(this.state.snippets);
  }

  private commit(next: SnippetsEditorState, merge: string | null): boolean {
    if (!this.fitsList(next.snippets)) {
      this.refuseSize();
      return false;
    }
    const at = this.now();
    const top = this.past.at(-1);
    if (merge !== null && top && top.merge === merge && at - top.at < this.mergeMs && this.future.length === 0) {
      top.after = next;
      top.at = at;
    } else {
      this.past.push({ before: this.state, after: next, merge, at });
      if (this.past.length > this.maxSteps) this.past.splice(0, this.past.length - this.maxSteps);
    }
    this.future = [];
    this.apply(next);
    return true;
  }

  private apply(next: SnippetsEditorState): void {
    const changed = next.snippets !== this.state.snippets;
    this.state = next;
    if (changed) this.notice = this.notice?.tone === 'error' ? null : this.notice;
    this.publish();
    if (changed) this.report();
  }

  /** The stored form of `snippets`: one object per list (value() and onChange agree by identity). */
  private valueOf(snippets: readonly EditableSnippet[]): unknown {
    if (snippets === this.initialSnippets) return this.initialValue;
    if (this.lastValue?.snippets === snippets) return this.lastValue.value;
    const value = storedSnippets(snippets);
    this.remember(value);
    this.lastValue = { snippets, value };
    return value;
  }

  private report(): void {
    const value = this.valueOf(this.state.snippets);
    this.remember(value);
    this.onChange?.(value);
  }

  private remember(value: unknown): void {
    if (isObject(value)) this.reported.add(value);
  }

  private makeSnapshot(): SnippetsEditorSnapshot {
    return {
      snippets: this.state.snippets,
      selected: this.state.selected,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      size: this.sizeOf(this.state.snippets),
      maxSize: this.maxSize,
      notice: this.notice,
    };
  }

  private publish(): void {
    this.snapshot = this.makeSnapshot();
    for (const listener of [...this.listeners]) listener();
  }
}
