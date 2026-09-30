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
  return (await page.evaluate(`window.__bugbash.detect(${JSON.stringify(opts)})`)) as Candidate[];
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
