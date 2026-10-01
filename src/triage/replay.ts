import { chromium, webkit, firefox, type Browser } from 'playwright';
import { Driver } from '../replay/driver.js';
import { runDetectors, settle, type Candidate } from '../detect/index.js';
import type { BrowserName, Step, Variant } from '../store/schema.js';
import type { Config } from '../config.js';
import { normalizeSteps, suffixFromLastGoto } from './steps.js';

const isInteraction = (s: Step) => s.action !== 'resize' && s.action !== 'variant' && s.action !== 'goto';

export const DETECTABLE = new Set(['text-overflow', 'spill-out', 'overlap', 'too-close', 'viewport-overflow', 'small-tap-target', 'broken-image', 'layout-shift']);
const ALIASES: Record<string, string[]> = {
  'text-overflow': ['text-overflow', 'spill-out'],
  'spill-out': ['spill-out', 'text-overflow'],
  overlap: ['overlap'],
  'too-close': ['too-close', 'small-tap-target'],
  'small-tap-target': ['small-tap-target', 'too-close'],
};

export interface DefectSpec {
  type: string;
  selector: string | null;
  relatedSelector: string | null;
  signature: string | null;
}

export type Presence = 'present' | 'absent' | 'unverifiable';

/** Shared browsers for replays (one per engine). */
export class BrowserPool {
  private browsers = new Map<BrowserName, Promise<Browser>>();
  get(name: BrowserName): Promise<Browser> {
    if (!this.browsers.has(name)) this.browsers.set(name, ({ chromium, webkit, firefox }[name]).launch());
    return this.browsers.get(name)!;
  }
  async close() {
    for (const b of this.browsers.values()) await (await b).close().catch(() => {});
  }
}

export interface ReplayOptions {
  baseUrl: string;
  browser: BrowserName;
  initialViewport: { width: number; height: number };
  variant?: Partial<Variant>;
  guardrails: Config['guardrails'];
  pool?: BrowserPool;
  recordVideoDir?: string | null;
  slowMo?: number;
  /** Called before each step (captions, rings). */
  beforeStep?: (d: Driver, step: Step, i: number) => Promise<void>;
  afterStep?: (d: Driver, step: Step, i: number) => Promise<void>;
}

export async function replay(steps: Step[], o: ReplayOptions): Promise<{ driver: Driver; failedStep: number | null; error: string | null }> {
  const first = steps.find((s) => s.action === 'resize') as Extract<Step, { action: 'resize' }> | undefined;
  const driver = new Driver({
    browser: o.browser,
    baseUrl: o.baseUrl,
    viewport: first ? { width: first.width, height: first.height } : o.initialViewport,
    variant: o.variant,
    guardrails: o.guardrails,
    sharedBrowser: o.recordVideoDir ? undefined : await o.pool?.get(o.browser),
    recordVideoDir: o.recordVideoDir ?? null,
    slowMo: o.slowMo,
  });
  await driver.start();
  for (let i = 0; i < steps.length; i++) {
    try {
      await o.beforeStep?.(driver, steps[i], i);
      const rebuilt = await driver.apply(steps[i]);
      // A device/DPR switch rebuilds the context: restore the page state reached so far.
      if (rebuilt === true) for (const s of suffixFromLastGoto(steps.slice(0, i)).filter(isInteraction)) await driver.apply(s).catch(() => {});
      await o.afterStep?.(driver, steps[i], i);
    } catch (e) {
      return { driver, failedStep: i, error: (e as Error).message.split('\n')[0] };
    }
  }
  return { driver, failedStep: null, error: null };
}

export function matchCandidate(cands: Candidate[], spec: DefectSpec): Candidate | null {
  const types = ALIASES[spec.type] ?? [spec.type];
  const pool = cands.filter((c) => types.includes(c.type) && c.confidence >= 0.35);
  if (spec.type === 'layout-shift') return pool[0] ?? null;
  const sels = [spec.selector, spec.relatedSelector].filter(Boolean) as string[];
  return (
    pool.find((c) => sels.includes(c.selector ?? '') || (c.related && sels.includes(c.related.selector ?? ''))) ??
    // Selectors can drift slightly between runs (nth-of-type); fall back to same component signature + type.
    (spec.signature ? pool.find((c) => c.signature === spec.signature) : undefined) ??
    null
  );
}

export async function checkPresence(driver: Driver, spec: DefectSpec): Promise<{ presence: Presence; candidate: Candidate | null }> {
  if (!DETECTABLE.has(spec.type)) return { presence: 'unverifiable', candidate: null };
  if (spec.type === 'layout-shift') await driver.page.waitForTimeout(2500);
  else await settle(driver.page, 200);
  await driver.refreshVariant();
  const types = ALIASES[spec.type] ?? [spec.type];
  const cands = await runDetectors(driver.page, { only: types }).catch(() => [] as Candidate[]);
  const c = matchCandidate(cands, spec);
  return { presence: c ? 'present' : 'absent', candidate: c };
}

export async function replayAndCheck(steps: Step[], spec: DefectSpec, o: ReplayOptions): Promise<{ presence: Presence; candidate: Candidate | null; error: string | null }> {
  const { driver, error } = await replay(steps, o);
  try {
    if (error) return { presence: 'absent', candidate: null, error };
    const r = await checkPresence(driver, spec);
    return { ...r, error: null };
  } finally {
    await driver.close();
  }
}

/**
 * Delta-debugging-lite: shortest step sequence that still reproduces the defect.
 * First tries "environment + everything since the last navigation", then removes steps one at a time.
 */
export async function minimize(steps: Step[], spec: DefectSpec, o: ReplayOptions, maxTries = 18): Promise<{ steps: Step[]; tries: number }> {
  let best = normalizeSteps(steps);
  let tries = 0;
  const reproduces = async (s: Step[]) => {
    tries++;
    return (await replayAndCheck(s, spec, o)).presence === 'present';
  };
  const suffix = suffixFromLastGoto(best);
  if (suffix.length < best.length && (await reproduces(suffix))) best = suffix;
  for (let i = best.length - 1; i >= 0 && tries < maxTries; i--) {
    const s = best[i];
    // Keep at least one navigation, and the final viewport.
    if (s.action === 'goto' && best.filter((x) => x.action === 'goto').length === 1) continue;
    if (s.action === 'resize' && !best.slice(i + 1).some((x) => x.action === 'resize')) continue;
    const candidate = [...best.slice(0, i), ...best.slice(i + 1)];
    if (await reproduces(candidate)) best = candidate;
  }
  return { steps: best, tries };
}
