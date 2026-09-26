import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPortalRoot, isInLaterLayer, isInToastLayer, LAYER_ATTR, pushModalLayer, registerEscape, topModalLayer } from './layers';

function layer(kind: 'layer' | 'toast' = 'layer'): HTMLDivElement {
  const el = document.createElement('div');
  el.setAttribute(LAYER_ATTR, kind);
  getPortalRoot().append(el);
  return el;
}

afterEach(() => {
  getPortalRoot().replaceChildren();
  document.body.querySelectorAll('[data-test-app]').forEach((el) => el.remove());
});

describe('portal root and layers', () => {
  it('creates one portal root at the end of body', () => {
    const root = getPortalRoot();
    expect(root.parentElement).toBe(document.body);
    expect(getPortalRoot()).toBe(root);
  });

  it('knows which layers came later and which is the toaster', () => {
    const a = layer();
    const toast = layer('toast');
    const b = layer();
    const inB = document.createElement('button');
    b.append(inB);
    expect(isInLaterLayer(inB, a)).toBe(true);
    expect(isInLaterLayer(a, b)).toBe(false);
    expect(isInLaterLayer(inB, b)).toBe(false);
    expect(isInToastLayer(toast)).toBe(true);
    expect(isInToastLayer(inB)).toBe(false);
  });
});

describe('modal stack', () => {
  it('makes everything but the top modal (and the toaster and later layers) inert, and restores it', () => {
    const app = document.createElement('div');
    app.setAttribute('data-test-app', '');
    document.body.prepend(app);
    const alreadyInert = document.createElement('div');
    alreadyInert.setAttribute('data-test-app', '');
    alreadyInert.setAttribute('inert', '');
    document.body.prepend(alreadyInert);
    const popover = layer();
    const toaster = layer('toast');
    const dialog = layer();

    const release = pushModalLayer(dialog);
    expect(topModalLayer()).toBe(dialog);
    expect(app.hasAttribute('inert')).toBe(true);
    expect(popover.hasAttribute('inert')).toBe(true);
    expect(toaster.hasAttribute('inert')).toBe(false);
    expect(dialog.hasAttribute('inert')).toBe(false);
    expect(document.documentElement.style.overflow).toBe('hidden');

    const nested = layer();
    const releaseNested = pushModalLayer(nested);
    expect(dialog.hasAttribute('inert')).toBe(true);
    releaseNested();
    expect(dialog.hasAttribute('inert')).toBe(false);
    expect(topModalLayer()).toBe(dialog);

    release();
    expect(topModalLayer()).toBeUndefined();
    expect(app.hasAttribute('inert')).toBe(false);
    expect(popover.hasAttribute('inert')).toBe(false);
    expect(alreadyInert.hasAttribute('inert')).toBe(true);
    expect(document.documentElement.style.overflow).toBe('');
  });
});

describe('escape stack', () => {
  it('routes Escape to the most recent registration only', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = registerEscape(first);
    const offSecond = registerEscape(second);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    offSecond();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(first).toHaveBeenCalledOnce();
    offFirst();
  });

  it('ignores Escape that a control already handled', () => {
    const handler = vi.fn();
    const off = registerEscape(handler);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
    off();
  });
});
