import type { Page } from 'playwright';
import type { Finding, Step } from '../store/schema.js';
import type { Driver } from '../replay/driver.js';

/**
 * Finds the finding's element on the page and marks it with data-bugbash-target, returning a selector for it. Fixes
 * often change an element's classes, so when the recorded selector no longer matches, the element is found by its tag
 * and text (e.g. the menu link "AI HACKATHON"). Returns null if neither finds it.
 */
export async function markTarget(page: Page, el: { selector: string | null; text: string | null }): Promise<string | null> {
  const src = `(() => {
    const sel = ${JSON.stringify(el.selector)}, text = ${JSON.stringify(el.text)};
    for (const old of document.querySelectorAll('[data-bugbash-target]')) old.removeAttribute('data-bugbash-target');
    let hit = null;
    try { hit = sel ? document.querySelector(sel) : null; } catch (e) {}
    if (!hit && text && text.trim()) {
      const want = text.replace(/\\s+/g, ' ').trim().toLowerCase();
      const tag = sel && /^[a-z][a-z0-9-]*/i.test(sel) ? sel.match(/^[a-z][a-z0-9-]*/i)[0] : '*';
      const norm = (n) => (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const all = [...document.querySelectorAll(tag)].filter((n) => norm(n) === want);
      hit = all.find((n) => n.getClientRects().length) || all[0] || null;
    }
    if (!hit) return null;
    hit.setAttribute('data-bugbash-target', '1');
    return '[data-bugbash-target="1"]';
  })()`;
  return page.evaluate(src).catch(() => null) as Promise<string | null>;
}

/**
 * Scroll bugs (a menu that can't be scrolled, a page that scrolls behind an open overlay) are about what happens when
 * a person scrolls, not about how the page looks after a scripted jump: `window.scrollTo` moves the page even when
 * scrolling is locked, so a still taken after it can't tell fixed from broken. These bugs are checked by doing the
 * gesture and measuring what moved.
 */
export const needsGesture = (f: Pick<Finding, 'type' | 'title' | 'reproduction'>) => ['scroll-trap', 'overlay-overflow'].includes(f.type) || (f.type === 'broken-state' && /\b(scroll|swipe)/i.test(`${f.title} ${f.reproduction.actual}`));

/** The finding's steps up to the state to probe: trailing scripted scrolls (the thing a gesture replaces) dropped. */
export function gestureSteps(f: Finding): Step[] {
  const steps = [...(f.reproduction.steps_minimal.length ? f.reproduction.steps_minimal : f.reproduction.steps_original)];
  while (steps.length && ['scroll', 'wait'].includes(steps[steps.length - 1].action)) steps.pop();
  return steps;
}

/** Up to four swipes of this size: enough to reach the end of a phone-sized menu. */
export const SWIPES = 4;
export const SWIPE_DY = 400;

export interface GestureResult {
  /** true: still broken; false: behaves; null: nothing to judge (no open overlay holding the element). */
  present: boolean | null;
  reason: string;
  page_moved_px: number;
  container_moved_px: number;
  reachable: boolean;
  /** Where the swipes were made (the overlay holding the element). */
  over: string | null;
}

/** Swipes over the open overlay that holds the finding's element and measures what moved. */
export async function probeScroll(driver: Driver, el: { selector: string | null; text: string | null }): Promise<GestureResult> {
  const none = (reason: string): GestureResult => ({ present: null, reason, page_moved_px: 0, container_moved_px: 0, reachable: false, over: null });
  const p = driver.page;
  const target = await markTarget(p, el);
  if (!target) return none("The element isn't on the page at this point");
  // Plain JS (no bundler helpers in the page): where the element is, and the fixed layer holding it.
  const read = () =>
    p.evaluate(`(() => {
      const el = document.querySelector('[data-bugbash-target="1"]');
      if (!el) return null;
      let layer = el;
      while (layer && getComputedStyle(layer).position !== 'fixed') layer = layer.parentElement;
      let inner = 0;
      for (let x = el.parentElement; x && x !== document.body; x = x.parentElement) inner += x.scrollTop;
      const r = el.getBoundingClientRect();
      if (layer && !layer.hasAttribute('data-bugbash-layer')) layer.setAttribute('data-bugbash-layer', '1');
      return { pageY: scrollY, inner, onScreen: r.height > 0 && r.top >= -1 && r.bottom <= innerHeight + 1, layer: layer ? layer.tagName.toLowerCase() + (layer.id ? '#' + layer.id : '') : null };
    })()`) as Promise<{ pageY: number; inner: number; onScreen: boolean; layer: string | null } | null>;
  const start = await read();
  if (!start) return none("The element isn't on the page at this point");
  if (!start.layer) return none("The element isn't inside an open overlay, so there's no scroll behaviour to compare");
  const over = '[data-bugbash-layer="1"]';
  let now = start;
  let reachable = start.onScreen;
  for (let i = 0; i < SWIPES && !reachable; i++) {
    await driver.swipe(over, SWIPE_DY);
    await p.waitForTimeout(250);
    now = (await read()) ?? now;
    reachable = now.onScreen;
  }
  // One more swipe once it's reachable: a locked page must not move behind the overlay either.
  if (reachable) {
    await driver.swipe(over, SWIPE_DY);
    await p.waitForTimeout(250);
    now = (await read()) ?? now;
  }
  const pageMoved = Math.round(Math.abs(now.pageY - start.pageY));
  const innerMoved = Math.round(Math.abs(now.inner - start.inner));
  const problems = [!reachable ? `the element never came on screen after ${SWIPES} swipes` : '', pageMoved > 20 ? `the page behind the overlay scrolled ${pageMoved}px` : ''].filter(Boolean);
  return {
    present: problems.length > 0,
    reason: problems.length ? `Scrolling over the open overlay: ${problems.join(', and ')}${innerMoved ? ` (the overlay itself scrolled ${innerMoved}px)` : ' (the overlay itself did not scroll)'}.` : `Scrolling over the open overlay scrolls it (${innerMoved}px) and brings the element on screen; the page behind stays put.`,
    page_moved_px: pageMoved,
    container_moved_px: innerMoved,
    reachable,
    over: start.layer,
  };
}
