// The `:` icon suggestion list (P5.5): a listbox under the `:query`, rendered from the
// iconSuggestion plugin state (icons/suggestion.ts). Focus stays in the text; the editor element
// points at the highlighted option with aria-activedescendant. It is portalled to the UI kit's
// portal root (position: fixed), outside the canvas viewport, which confines fixed elements.
import type { PluginView } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { computePosition, getPortalRoot } from '@/ui';
import { iconClasses } from '../../icons/catalog';
import { acceptSuggestion, iconSuggestionKey, moveSuggestion, suggestionIds, type IconSuggestionState } from '../../icons/suggestion';
import styles from './iconPicker.module.css';

/** A glyph preview element: the icon inside a .hb-canvas span, where the theme's icon CSS applies. */
export function glyphElement(doc: Document, classes: string): HTMLElement {
  const box = doc.createElement('span');
  box.className = `${styles.glyph} hb-canvas`;
  box.setAttribute('aria-hidden', 'true');
  const i = doc.createElement('i');
  i.className = classes;
  box.append(i);
  return box;
}

export class IconSuggestionPopup implements PluginView {
  readonly dom: HTMLUListElement;
  private readonly view: EditorView;
  private rendered: IconSuggestionState | null = null;

  constructor(view: EditorView) {
    this.view = view;
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('ul');
    this.dom.className = styles.suggestions!;
    this.dom.setAttribute('role', 'listbox');
    this.dom.setAttribute('aria-label', 'Icons');
    this.dom.setAttribute('data-testid', 'icon-suggestions');
    this.dom.id = suggestionIds(view).listbox;
    this.dom.hidden = true;
    // Keep the focus (and the caret) in the text when an option is clicked.
    this.dom.addEventListener('mousedown', (e) => e.preventDefault());
    this.dom.addEventListener('click', (e) => {
      const option = (e.target as Element | null)?.closest<HTMLElement>('[data-index]');
      if (!option) return;
      acceptSuggestion(this.view, Number(option.dataset.index));
      this.view.focus();
    });
    this.dom.addEventListener('mousemove', (e) => {
      const option = (e.target as Element | null)?.closest<HTMLElement>('[data-index]');
      const s = iconSuggestionKey.getState(this.view.state);
      if (option && s?.active && Number(option.dataset.index) !== s.index) moveSuggestion(this.view, Number(option.dataset.index));
    });
    getPortalRoot(doc).append(this.dom);
    this.update(view);
  }

  update(view: EditorView): void {
    const s = iconSuggestionKey.getState(view.state);
    if (!s?.active || !view.editable) {
      this.dom.hidden = true;
      this.rendered = null;
      return;
    }
    if (this.rendered?.results !== s.results) this.renderOptions(s);
    else if (this.rendered.index !== s.index) this.highlight(s.index);
    this.rendered = s;
    this.dom.hidden = false;
    this.position(s);
  }

  private renderOptions(s: IconSuggestionState): void {
    const doc = this.dom.ownerDocument;
    const ids = suggestionIds(this.view);
    this.dom.replaceChildren(
      ...s.results.map((icon, i) => {
        const li = doc.createElement('li');
        li.className = styles.option!;
        li.id = ids.option(i);
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === s.index));
        li.dataset.index = String(i);
        li.dataset.icon = icon.name;
        const name = doc.createElement('span');
        name.className = styles.optionName!;
        name.textContent = icon.label;
        const code = doc.createElement('span');
        code.className = styles.optionCode!;
        code.textContent = `:${icon.name}:`;
        code.setAttribute('aria-hidden', 'true');
        li.append(glyphElement(doc, iconClasses(icon)), name, code);
        return li;
      }),
    );
  }

  private highlight(index: number): void {
    for (const li of Array.from(this.dom.children)) {
      const selected = (li as HTMLElement).dataset.index === String(index);
      li.setAttribute('aria-selected', String(selected));
      if (selected) (li as HTMLElement).scrollIntoView?.({ block: 'nearest' });
    }
  }

  private position(s: IconSuggestionState): void {
    let rect: { top: number; bottom: number; left: number; right: number; width: number; height: number };
    try {
      const c = this.view.coordsAtPos(s.from);
      rect = { top: c.top, bottom: c.bottom, left: c.left, right: c.right, width: Math.max(1, c.right - c.left), height: c.bottom - c.top };
    } catch {
      return;
    }
    const win = this.dom.ownerDocument.defaultView;
    const size = this.dom.getBoundingClientRect();
    const pos = computePosition({
      anchor: rect,
      floating: { width: size.width, height: size.height },
      viewport: { width: win?.innerWidth ?? 1024, height: win?.innerHeight ?? 768 },
      placement: 'bottom-start',
      offset: 4,
      padding: 8,
    });
    this.dom.style.top = `${pos.top}px`;
    this.dom.style.left = `${pos.left}px`;
    this.dom.style.maxHeight = `${Math.max(120, pos.maxHeight)}px`;
  }

  destroy(): void {
    this.dom.remove();
  }
}
