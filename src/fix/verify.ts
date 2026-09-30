import type { Finding, Step } from '../store/schema.js';
import type { Config } from '../config.js';
import { BrowserPool, replay, checkPresence, DETECTABLE, type DefectSpec } from '../triage/replay.js';
import { runDetectors, settle, type Candidate } from '../detect/index.js';
import { annotateDefect } from '../triage/annotate.js';

export interface VerifyResult {
  id: string;
  verifiable: boolean;
  present: boolean | null; // null = not auto-verifiable
  checks: { browser: string; width: number; height: number; present: boolean | null; error: string | null }[];
}

export function specOf(f: Finding): DefectSpec {
  return { type: f.type, selector: f.element.selector, relatedSelector: (f.metrics?.related as { selector?: string } | undefined)?.selector ?? null, signature: f.element.signature };
}

/** Steps with the final viewport swapped for `vp` (to check every affected width). */
function atViewport(steps: Step[], vp: { width: number; height: number }): Step[] {
  let last = -1;
  steps.forEach((s, i) => s.action === 'resize' && (last = i));
  const out = [...steps];
  if (last >= 0) out[last] = { action: 'resize', width: vp.width, height: vp.height };
  else out.unshift({ action: 'resize', width: vp.width, height: vp.height });
  return out;
}

/** Representative viewports: the reproduction viewport plus the extremes of the affected range (max 3). */
export function checkViewports(f: Finding) {
  const env = f.reproduction.environment.viewport;
  const vps = [env, ...f.viewports];
  const byW = new Map(vps.map((v) => [v.width, v]));
  const ws = [...byW.keys()].sort((a, b) => a - b);
  const pick = [...new Set([env.width, ws[0], ws[ws.length - 1]])];
  return pick.map((w) => byW.get(w)!);
}

export async function verifyFinding(f: Finding, o: { baseUrl: string; guardrails: Config['guardrails']; pool: BrowserPool }): Promise<VerifyResult> {
  const steps = f.reproduction.steps_minimal.length ? f.reproduction.steps_minimal : f.reproduction.steps_original;
  const spec = specOf(f);
  const res: VerifyResult = { id: f.id, verifiable: DETECTABLE.has(f.type) && f.reproduction.rate != null && f.reproduction.rate !== '0/1', present: null, checks: [] };
  if (!res.verifiable) return res;
  const browsers = f.browsers.length ? f.browsers : [f.reproduction.environment.browser];
  for (const browser of browsers) {
    for (const vp of checkViewports(f)) {
      const { driver, error } = await replay(atViewport(steps, vp), { baseUrl: o.baseUrl, browser, initialViewport: vp, variant: f.reproduction.environment.variant, guardrails: o.guardrails, pool: o.pool });
      try {
        const r = error ? { presence: 'absent' as const } : await checkPresence(driver, spec);
        res.checks.push({ browser, width: vp.width, height: vp.height, present: r.presence === 'present', error });
      } finally {
        await driver.close();
      }
    }
  }
  // The reproduction environment is authoritative; other widths are "affected range" samples.
  const envCheck = res.checks.find((c) => c.browser === f.reproduction.environment.browser && c.width === f.reproduction.environment.viewport.width);
  res.present = res.checks.some((c) => c.present) || !!envCheck?.present;
  return res;
}

/** Screenshot of the finding's area after replaying its steps (for before/after evidence). */
export async function captureAfter(f: Finding, file: string, o: { baseUrl: string; guardrails: Config['guardrails']; pool: BrowserPool }) {
  const steps = f.reproduction.steps_minimal.length ? f.reproduction.steps_minimal : f.reproduction.steps_original;
  const { driver } = await replay(steps, { baseUrl: o.baseUrl, browser: f.reproduction.environment.browser, initialViewport: f.reproduction.environment.viewport, variant: f.reproduction.environment.variant, guardrails: o.guardrails, pool: o.pool });
  try {
    await annotateDefect(driver.page, { selector: f.element.selector, relatedSelector: null, fallbackBBox: f.element.bbox, label: `${f.id} after fix`, files: { annotated: file, crop: file.replace(/\.png$/, '-crop.png'), full: file.replace(/\.png$/, '-full.png') } });
  } finally {
    await driver.close();
  }
}

/** High-confidence detector candidates on a page at a few widths (for regression comparison). */
export async function pageSnapshot(path: string, o: { baseUrl: string; guardrails: Config['guardrails']; pool: BrowserPool; widths?: number[] }): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  for (const w of o.widths ?? [320, 768, 1280]) {
    const { driver } = await replay([{ action: 'resize', width: w, height: 800 }, { action: 'goto', url: path }], { baseUrl: o.baseUrl, browser: 'chromium', initialViewport: { width: w, height: 800 }, guardrails: o.guardrails, pool: o.pool });
    try {
      await settle(driver.page, 300);
      for (const c of await runDetectors(driver.page).catch(() => [] as Candidate[])) if (c.confidence >= 0.6) out.set(`${w}|${c.type}|${c.selector}`, c);
    } finally {
      await driver.close();
    }
  }
  return out;
}
