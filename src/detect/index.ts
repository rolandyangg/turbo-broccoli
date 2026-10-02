import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { BBox } from '../store/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
export const INPAGE_SOURCE = readFileSync(join(here, 'inpage.js'), 'utf8');

export interface Candidate {
  type: string;
  selector: string | null;
  text: string;
  bbox: BBox;
  signature: string;
  confidence: number;
  message: string;
  metrics: Record<string, unknown>;
  related: { selector: string | null; text: string; bbox: BBox } | null;
}

export interface DetectOptions {
  minGapPx?: number;
  minTapTargetPx?: number;
  edgePaddingPx?: number;
  only?: string[] | null;
  scope?: string | null;
  /**
   * What to look at: 'viewport' (as scrolled now), 'page' (scroll down the whole page, the default) or a selector
   * to scroll into view first. Checks that ask the browser what is on top (overlaps, hidden text, focus) only see
   * what's on screen, so a single top-of-page pass misses collisions further down.
   */
  scan?: 'viewport' | 'page' | { selector: string };
}

/** Install detectors (and layout-shift tracking) into every page of the context from first paint. */
export async function installDetectors(context: BrowserContext) {
  await context.addInitScript({ content: INPAGE_SOURCE });
}

export async function ensureDetectors(page: Page) {
  const ok = await page.evaluate('!!(window.__bugbash && window.__bugbash.version === 1)').catch(() => false);
  if (!ok) await page.evaluate(INPAGE_SOURCE);
}

export async function runDetectors(page: Page, opts: DetectOptions = {}): Promise<Candidate[]> {
  await ensureDetectors(page);
  const { scan = 'page', ...inPage } = opts;
  const once = async () => {
    const c = (await page.evaluate(`window.__bugbash.detect(${JSON.stringify(inPage)})`)) as Candidate[];
    if (!opts.only || opts.only.includes('mirrored-text')) c.push(...(await paintedBackFaces(page)));
    return c;
  };
  if (scan === 'viewport') return once();
  if (typeof scan === 'object') {
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), scan.selector).catch(() => {});
    await page.waitForTimeout(150);
    return once();
  }
  // Whole page: one pass per screenful (capped), then put the scroll back where it was.
  const { y0, h, total } = (await page.evaluate('({ y0: scrollY, h: innerHeight, total: document.documentElement.scrollHeight })')) as { y0: number; h: number; total: number };
  const best = new Map<string, Candidate>();
  const step = Math.max(200, Math.round(h * 0.85));
  for (let y = 0, n = 0; n < 14; y += step, n++) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' as ScrollBehavior }), y).catch(() => {});
    await page.waitForTimeout(80);
    for (const c of await once()) {
      const k = `${c.type}|${c.selector}`;
      if (!best.has(k) || best.get(k)!.confidence < c.confidence) best.set(k, c);
    }
    if (y + h >= total) break;
  }
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' as ScrollBehavior }), y0).catch(() => {});
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

export interface Landmark {
  key: string;
  label: string;
  /** Why it can't be seen at this width (absent, display:none, …), or null when shown. */
  hidden: string | null;
  selector: string | null;
  text: string;
  bbox: BBox;
  signature: string;
}

/** The page's primary content (first h1, primary CTA, hero form) and whether each is shown at the current width. */
export async function landmarks(page: Page): Promise<Landmark[]> {
  await ensureDetectors(page);
  return (await page.evaluate('window.__bugbash.landmarks()')) as Landmark[];
}

/**
 * Primary content shown at one sweep width but missing at a neighbouring one (within `near` px): a 'broken-state'
 * candidate per landmark, with the widths where it is missing.
 */
export function missingLandmarks(rows: { width: number; marks: Landmark[] }[], near = 100): { candidate: Candidate; widths: number[] }[] {
  const out: { candidate: Candidate; widths: number[] }[] = [];
  const keys = [...new Set(rows.flatMap((r) => r.marks.map((m) => m.key)))];
  for (const key of keys) {
    const at = rows.map((r) => ({ width: r.width, m: r.marks.find((m) => m.key === key) })).filter((a): a is { width: number; m: Landmark } => !!a.m);
    const shown = at.filter((a) => !a.m.hidden);
    const missing = at.filter((a) => a.m.hidden && shown.some((s) => Math.abs(s.width - a.width) <= near));
    if (!missing.length) continue;
    const widths = missing.map((a) => a.width).sort((a, b) => a - b);
    const neighbours = [...new Set(shown.filter((s) => missing.some((a) => Math.abs(s.width - a.width) <= near)).map((s) => s.width))].sort((a, b) => a - b);
    const ref = shown.find((s) => s.width === neighbours[0])!.m;
    const why = [...new Set(missing.map((a) => a.m.hidden))].join(', ');
    const range = widths.length > 1 ? `${widths[0]}–${widths[widths.length - 1]}px` : `${widths[0]}px`;
    const bbox = missing.find((a) => a.m.selector)?.m.bbox ?? ref.bbox;
    out.push({
      widths,
      candidate: {
        type: 'broken-state',
        selector: ref.selector,
        text: ref.text,
        bbox,
        signature: ref.signature,
        confidence: 0.8,
        message: `${ref.label} "${ref.text.slice(0, 40)}" is missing at ${range} (${why}) but shown at ${neighbours.join(', ')}px.`,
        metrics: { landmark: key, hidden_reason: why, widths, shown_widths: neighbours, width_range: [widths[0], widths[widths.length - 1]] },
        related: null,
      },
    });
  }
  return out;
}

/**
 * Turned-away flip-card faces should not be painted (backface-visibility: hidden), but some engines draw them
 * anyway, mirrored (e.g. Safari inside scrolling or will-change containers). The page's styles can't reveal that, so
 * compare pixels: screenshot the spot, hide the face, screenshot again. If they differ, the hidden face was painted.
 */
async function paintedBackFaces(page: Page): Promise<Candidate[]> {
  const faces = (await page.evaluate('window.__bugbash.flipFaces()').catch(() => [])) as { selector: string; text: string; bbox: BBox; page_bbox: BBox; signature: string }[];
  const out: Candidate[] = [];
  for (const f of faces) {
    const clip = { x: f.bbox.x, y: f.bbox.y, width: Math.max(1, f.bbox.width), height: Math.max(1, f.bbox.height) };
    const before = await page.screenshot({ clip, animations: 'disabled' }).catch(() => null);
    const hid = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      el.dataset.bbPrevVis = el.style.visibility;
      el.style.visibility = 'hidden';
      return true;
    }, f.selector);
    if (!before || !hid) continue;
    const after = await page.screenshot({ clip, animations: 'disabled' }).catch(() => null);
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) el.style.visibility = el.dataset.bbPrevVis ?? '';
    }, f.selector);
    if (after && !before.equals(after))
      out.push({ type: 'mirrored-text', selector: f.selector, text: f.text, bbox: f.page_bbox, signature: f.signature, confidence: 0.9, message: 'The hidden back face of this flip card is painted on top, so its text shows mirrored (backface-visibility: hidden is not honoured here; common in Safari inside scrolling or will-change containers).', metrics: { painted_back_face: true }, related: null });
  }
  return out;
}

/** Wait for layout to settle: network quiet-ish, fonts loaded, two animation frames. */
export async function settle(page: Page, ms = 250) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.evaluate('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => {});
  await page
    .evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
    .catch(() => {});
  if (ms) await page.waitForTimeout(ms);
}

/**
 * Temporal probe: screenshots at 0/100/300/1000ms after an action and reports which intervals changed,
 * plus any layout-shift entries recorded meanwhile. Used to decide static vs temporal evidence.
 */
export async function temporalSignals(page: Page): Promise<string[]> {
  const signals: string[] = [];
  const shots: Buffer[] = [];
  const times = [0, 100, 300, 1000];
  let last = 0;
  for (const t of times) {
    await page.waitForTimeout(t - last);
    last = t;
    shots.push(await page.screenshot({ animations: 'allow' }).catch(() => Buffer.alloc(0)));
  }
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].length && !shots[i].equals(shots[i - 1])) signals.push(`visual-change:${times[i - 1]}-${times[i]}ms`);
  }
  const shifts = (await page.evaluate('window.__bugbash ? window.__bugbash.shifts.filter(s => s.value >= 0.02).length : 0').catch(() => 0)) as number;
  if (shifts) signals.push(`layout-shift-entries:${shifts}`);
  return signals;
}
