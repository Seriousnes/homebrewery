// Page tracking logic with a scripted IntersectionObserver and fake rects (jsdom has no layout).
// Real scrolling, zoom and both browsers: web/e2e/panels/panels.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageTracker, type PageTracker } from './pageTracker';
import { canvasScrollTarget } from './scrollCanvas';

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit;
  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
  /** Delivers entries: [page element, ratio] pairs; `time` defaults to now. */
  fire(entries: [Element, number][], time = performance.now()) {
    this.callback(
      entries.map(([target, ratio]) => ({ target, intersectionRatio: ratio, isIntersecting: ratio > 0, time }) as unknown as IntersectionObserverEntry),
      this as unknown as IntersectionObserver,
    );
  }
}

const io = () => {
  const instance = FakeIntersectionObserver.instances.at(-1);
  if (!instance) throw new Error('no observer');
  return instance;
};

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function rect(top: number, left = 0, width = 100, height = 90): DOMRect {
  return { top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) };
}

interface Fixture {
  viewport: HTMLDivElement;
  root: HTMLDivElement;
  pages: HTMLDivElement[];
  tracker: PageTracker;
  scrollTo: ReturnType<typeof vi.fn>;
  states: () => ReturnType<PageTracker['getState']>;
}

/** `layout[i]` = [top, left] of page i+1 in screen px (scrollTop 0). */
function setup(layout: [number, number][]): Fixture {
  const viewport = document.createElement('div');
  const root = document.createElement('div');
  root.className = 'pages';
  viewport.appendChild(root);
  document.body.appendChild(viewport);
  const pages = layout.map(([top, left], i) => {
    const page = document.createElement('div');
    page.className = 'page';
    page.id = `p${i + 1}`;
    page.getBoundingClientRect = () => rect(top - viewport.scrollTop, left);
    root.appendChild(page);
    return page;
  });
  // A gap cursor or other non-page child is ignored.
  root.appendChild(Object.assign(document.createElement('div'), { className: 'ProseMirror-gapcursor' }));
  viewport.getBoundingClientRect = () => rect(0, 0, 800, 300);
  Object.defineProperty(viewport, 'clientHeight', { value: 300 });
  Object.defineProperty(viewport, 'clientWidth', { value: 800 });
  Object.defineProperty(viewport, 'scrollHeight', { value: 5000 });
  Object.defineProperty(viewport, 'scrollWidth', { value: 800 });
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    viewport.scrollTop = options.top ?? 0;
  });
  viewport.scrollTo = scrollTo as unknown as typeof viewport.scrollTo;
  const tracker = createPageTracker({ viewport: () => viewport, root: () => root });
  return { viewport, root, pages, tracker, scrollTo, states: () => tracker.getState() };
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const single = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [i * 100, 0]);

describe('createPageTracker', () => {
  it('observes nothing until subscribed, then every page of the root, in the viewport', () => {
    const f = setup(single(4));
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    const unsubscribe = f.tracker.subscribe(() => {});
    expect(io().options.root).toBe(f.viewport);
    expect([...io().observed]).toEqual(f.pages);
    expect(f.states()).toMatchObject({ current: 1, total: 4, atStart: true, atEnd: false });
    unsubscribe();
    expect(io().observed.size).toBe(0);
  });

  it('the current page shows the largest share of itself; visible pages are 30% or more in view', async () => {
    const f = setup(single(5));
    const listener = vi.fn();
    f.tracker.subscribe(listener);
    const [p1, p2, p3, p4] = f.pages;
    io().fire([
      [p1!, 0],
      [p2!, 0.25],
      [p3!, 0.6],
      [p4!, 0.35],
    ]);
    await flush();
    expect(f.states()).toMatchObject({ current: 3, visible: [3, 4] });
    expect(listener).toHaveBeenCalled();
    io().fire([
      [p3!, 0.2],
      [p4!, 0.9],
    ]);
    await flush();
    expect(f.states()).toMatchObject({ current: 4, visible: [4] });
  });

  it('on a tie the first page wins, and the current page stays while it ties', async () => {
    const f = setup(single(5));
    f.tracker.subscribe(() => {});
    const [, p2, p3, p4] = f.pages;
    io().fire([
      [p2!, 1],
      [p3!, 1],
      [p4!, 1],
    ]);
    await flush();
    expect(f.states().current).toBe(2);
    io().fire([[p2!, 0.5]]);
    await flush();
    expect(f.states().current).toBe(3);
    io().fire([[p2!, 1]]);
    await flush();
    // 2 ties again, but 3 was current and still ties.
    expect(f.states().current).toBe(3);
  });

  it('a jump makes its page current, also where the page can’t reach the top (the last page)', async () => {
    const f = setup(single(5));
    f.tracker.subscribe(() => {});
    const [, , p3, p4, p5] = f.pages;
    io().fire([
      [p3!, 1],
      [p4!, 1],
      [p5!, 1],
    ]);
    await flush();
    expect(f.states().current).toBe(3);
    expect(f.tracker.goToPage(5)).toBe(true);
    expect(f.states().current).toBe(5);
    expect(f.scrollTo).toHaveBeenLastCalledWith({ top: 400 - 16, left: 0, behavior: 'auto' });
    // Entries measured before the jump don't undo it …
    io().fire([[p3!, 1]], 0);
    await flush();
    expect(f.states().current).toBe(5);
    // … fresh ones where 5 still ties keep it …
    io().fire([[p5!, 1]]);
    await flush();
    expect(f.states().current).toBe(5);
    // … and once it no longer ties, the best page takes over.
    io().fire([[p5!, 0.4]]);
    await flush();
    expect(f.states().current).toBe(3);
  });

  it('clamps jumps and refuses nonsense', () => {
    const f = setup(single(3));
    f.tracker.subscribe(() => {});
    f.tracker.goToPage(99);
    expect(f.states().current).toBe(3);
    f.tracker.goToPage(-4);
    expect(f.states().current).toBe(1);
    expect(f.tracker.goToPage(Number.NaN)).toBe(false);
  });

  it('previous and next move by rows (facing pages)', () => {
    // Row 0: page 1 on the right; row 1: pages 2 and 3; row 2: pages 4 and 5.
    const f = setup([
      [0, 400],
      [100, 0],
      [100, 400],
      [200, 0],
      [200, 400],
    ]);
    f.tracker.subscribe(() => {});
    expect(f.states()).toMatchObject({ current: 1, atStart: true, atEnd: false });
    expect(f.tracker.goToNext()).toBe(true);
    expect(f.states()).toMatchObject({ current: 2, atStart: false, atEnd: false });
    f.tracker.goToNext();
    expect(f.states()).toMatchObject({ current: 4, atEnd: true });
    expect(f.tracker.goToNext()).toBe(false);
    f.tracker.goToPage(5);
    expect(f.states()).toMatchObject({ current: 5, atEnd: true });
    f.tracker.goToPrevious();
    expect(f.states().current).toBe(2);
    f.tracker.goToPrevious();
    expect(f.states().current).toBe(1);
    expect(f.tracker.goToPrevious()).toBe(false);
  });

  it('follows pages added and removed by pagination', async () => {
    const f = setup(single(2));
    const listener = vi.fn();
    f.tracker.subscribe(listener);
    const added = document.createElement('div');
    added.className = 'page';
    added.getBoundingClientRect = () => rect(200);
    f.root.insertBefore(added, f.pages[1]!.nextSibling);
    await flush();
    expect(f.states().total).toBe(3);
    expect(io().observed.has(added)).toBe(true);
    f.pages[0]!.remove();
    await flush();
    expect(f.states().total).toBe(2);
    expect(io().observed.has(f.pages[0]!)).toBe(false);
  });

  it('pageOf and scrollToElement', () => {
    const f = setup(single(3));
    f.tracker.subscribe(() => {});
    const heading = document.createElement('h2');
    heading.getBoundingClientRect = () => rect(250 - f.viewport.scrollTop);
    f.pages[2]!.appendChild(heading);
    expect(f.tracker.pageOf(heading)).toBe(3);
    expect(f.tracker.pageOf(document.body)).toBe(0);
    expect(f.tracker.scrollToElement(heading)).toBe(true);
    expect(f.scrollTo).toHaveBeenLastCalledWith({ top: 250 - 16, left: 0, behavior: 'auto' });
    expect(f.states().current).toBe(3);
  });

  it('works without subscribers for jumps (reads the root directly)', () => {
    const f = setup(single(3));
    expect(f.tracker.goToPage(2)).toBe(true);
    expect(f.scrollTo).toHaveBeenCalledWith({ top: 100 - 16, left: 0, behavior: 'auto' });
  });

  it('has no pages without a root', () => {
    const tracker = createPageTracker({ viewport: () => null, root: () => null });
    tracker.subscribe(() => {});
    expect(tracker.getState()).toMatchObject({ current: 0, total: 0 });
    expect(tracker.goToPage(1)).toBe(false);
  });
});

describe('canvasScrollTarget (zoom is in the rects)', () => {
  function viewportAt(scrollTop: number, scrollLeft = 0) {
    const vp = document.createElement('div');
    vp.getBoundingClientRect = () => rect(50, 0, 800, 600);
    Object.defineProperty(vp, 'clientHeight', { value: 600 });
    Object.defineProperty(vp, 'clientWidth', { value: 800 });
    Object.defineProperty(vp, 'scrollHeight', { value: 20000 });
    Object.defineProperty(vp, 'scrollWidth', { value: 3000 });
    vp.scrollTop = scrollTop;
    vp.scrollLeft = scrollLeft;
    return vp;
  }

  it('puts the target at the top, minus the margin', () => {
    const vp = viewportAt(1000);
    const target = document.createElement('h2');
    // A heading 300 screen px below the viewport top (at zoom 2 that is 150 CSS px).
    target.getBoundingClientRect = () => rect(350, 100, 200, 40);
    expect(canvasScrollTarget(vp, target, 16)).toEqual({ top: 1000 + 300 - 16, left: 0 });
  });

  it('brings an off-screen target into view horizontally, centred when it fits', () => {
    const vp = viewportAt(0, 500);
    const target = document.createElement('div');
    target.getBoundingClientRect = () => rect(100, -300, 400, 500);
    expect(canvasScrollTarget(vp, target, 16).left).toBe(500 - 300 - 200);
    const wide = document.createElement('div');
    wide.getBoundingClientRect = () => rect(100, 900, 1200, 500);
    expect(canvasScrollTarget(vp, wide, 16).left).toBe(500 + 900 - 16);
  });

  it('clamps to the scroll range', () => {
    const vp = viewportAt(0);
    const target = document.createElement('div');
    target.getBoundingClientRect = () => rect(0, 0, 100, 100);
    expect(canvasScrollTarget(vp, target, 16).top).toBe(0);
  });
});
