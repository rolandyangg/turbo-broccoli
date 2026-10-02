import type { Finding, Step } from '../store/schema.js';
import type { Config } from '../config.js';
import { BrowserPool, replay, checkPresence, DETECTABLE, type DefectSpec } from '../triage/replay.js';
import { runDetectors, settle, type Candidate } from '../detect/index.js';
import { annotateDefect } from '../triage/annotate.js';
import { recordVideo } from '../triage/video.js';
import { runAgent } from '../llm/runner.js';
import { needsGesture, gestureSteps, probeScroll, markTarget, SWIPES, SWIPE_DY, type GestureResult } from './gesture.js';
import type { BrowserName } from '../store/schema.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface VerifyResult {
  id: string;
  verifiable: boolean;
  /** true = still there; false = gone (every check agrees, or the visual review says so); null = couldn't tell. */
  present: boolean | null;
  method: 'detector' | 'visual-review' | 'none';
  checks: { browser: string; width: number; height: number; present: boolean | null; error: string | null; gesture?: GestureResult | null }[];
  review: { fixed: boolean; confidence: number; reasoning: string } | null;
  /** After-fix stills taken for the review (absolute paths), when one ran. */
  after: { annotated: string; crop: string; full: string; element_found: boolean } | null;
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
  // On a device profile the device sets the screen size: one check covers it.
  if (f.reproduction.environment.variant.device) return [env];
  const vps = [env, ...f.viewports];
  const byW = new Map(vps.map((v) => [v.width, v]));
  const ws = [...byW.keys()].sort((a, b) => a - b);
  const pick = [...new Set([env.width, ws[0], ws[ws.length - 1]])];
  return pick.map((w) => byW.get(w)!);
}

export interface VerifyOptions {
  baseUrl: string;
  guardrails: Config['guardrails'];
  pool: BrowserPool;
  /** When detectors can't settle it: capture after-fix stills here and have a model compare them with the before. */
  review?: { runDir: string; outDir: string; provider?: 'claude' | 'codex' | null; model?: string | null; transcriptDir?: string } | null;
}

export async function verifyFinding(f: Finding, o: VerifyOptions): Promise<VerifyResult> {
  const steps = f.reproduction.steps_minimal.length ? f.reproduction.steps_minimal : f.reproduction.steps_original;
  const spec = specOf(f);
  const gesture = needsGesture(f);
  const detectable = DETECTABLE.has(f.type) && f.reproduction.rate != null && f.reproduction.rate !== '0/1';
  const res: VerifyResult = { id: f.id, verifiable: detectable || gesture, present: null, method: 'none', checks: [], review: null, after: null };
  if (res.verifiable) {
    const browsers = f.browsers.length ? f.browsers : [f.reproduction.environment.browser];
    const replayIn = (st: Step[], browser: BrowserName, vp: { width: number; height: number }) => replay(atViewport(st, vp), { baseUrl: o.baseUrl, browser, initialViewport: vp, variant: f.reproduction.environment.variant, guardrails: o.guardrails, pool: o.pool });
    for (const browser of browsers) {
      for (const vp of checkViewports(f)) {
        // Scroll bugs: replay up to the state to scroll in (not the scripted jump), then do the gesture.
        const { driver, error } = await replayIn(gesture ? gestureSteps(f) : steps, browser, vp);
        let det: boolean | null = null;
        let g: GestureResult | null = null;
        let gestureError: string | null = null;
        try {
          // A replay that breaks (steps no longer apply) or a check that can't decide is NOT evidence of a fix.
          const r = error || !detectable ? null : await checkPresence(driver, spec);
          det = !r || r.presence === 'unverifiable' ? null : r.presence === 'present';
          if (gesture && !error) {
            if (driver.canSwipe) g = await probeScroll(driver, f.element);
            else {
              // Playwright can't swipe in mobile WebKit/Firefox: same device profile in Chromium for the gesture.
              const c = await replayIn(gestureSteps(f), 'chromium', vp);
              try {
                if (c.error) gestureError = `gesture replay failed: ${c.error}`;
                else g = await probeScroll(c.driver, f.element);
              } finally {
                await c.driver.close();
              }
            }
          }
        } catch (e) {
          gestureError = (e as Error).message.split('\n')[0];
        } finally {
          await driver.close();
        }
        // Either check seeing the bug means it's still there; it's gone only when no check sees it and one could tell.
        const present = det === true || g?.present === true ? true : det === false || g?.present === false ? false : null;
        res.checks.push({ browser: g && !driver.canSwipe ? `${browser} (swipe in chromium)` : browser, width: vp.width, height: vp.height, present, error: error ?? gestureError ?? (present === null ? (g?.reason ?? 'not checkable here') : null), gesture: g });
      }
    }
    if (res.checks.some((c) => c.present === true)) res.present = true;
    else if (res.checks.length && res.checks.every((c) => c.present === false)) res.present = false;
    if (res.present !== null) res.method = 'detector';
  }
  // Visual bugs (and inconclusive detector checks): compare before/after images of the same spot.
  if (res.present === null && o.review) {
    try {
      const base = join(o.review.outDir, `${f.id}-after`);
      const shot = await captureAfter(f, `${base}.png`, o);
      res.after = { annotated: `${base}.png`, crop: `${base}-crop.png`, full: `${base}-full.png`, element_found: shot.found };
      const review = await visualReview(f, o.review.runDir, res.after, o.review);
      if (review) {
        res.review = review;
        if (review.confidence >= 0.6) {
          res.present = !review.fixed;
          res.method = 'visual-review';
        }
      }
    } catch {}
  }
  return res;
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean', description: 'Is the described defect gone in the AFTER images?' },
    confidence: { type: 'number', description: '0..1' },
    reasoning: { type: 'string', description: '1-3 sentences: what you compared and what you saw' },
  },
  required: ['fixed', 'confidence', 'reasoning'],
};

/** A model compares the before and after images of the same spot, in the same environment, for the described bug. */
async function visualReview(f: Finding, runDir: string, after: { annotated: string; crop: string; full: string; element_found: boolean }, o: { provider?: 'claude' | 'codex' | null; model?: string | null; transcriptDir?: string }) {
  const before = [f.screenshots.crop, f.screenshots.annotated, f.video?.filmstrip].filter(Boolean).map((p) => join(runDir, p!)).filter((p) => existsSync(p));
  const afterFiles = [after.crop, after.annotated].filter((p) => existsSync(p));
  if (!before.length || !afterFiles.length) return null;
  const prompt = [
    `Decide whether a UI bug is fixed by comparing BEFORE and AFTER screenshots of the same page, browser, size and settings.`,
    `Bug ${f.id}: ${f.title}`,
    `Type: ${f.type}. Page: ${f.page}. Expected: ${f.reproduction.expected}. Actual before: ${f.reproduction.actual}.`,
    `BEFORE (red box marks the defect): ${before.join(', ')}`,
    `AFTER (green box marks the same element${after.element_found ? '' : '; it was NOT found after the fix, a blue box marks its old position'}): ${afterFiles.join(', ')}`,
    f.video ? 'This is a time-based bug (it happens during or after loading or interaction); the before filmstrip shows it over time. A still AFTER image can only partly confirm a fix; lower your confidence accordingly.' : '',
    `Read every image. Say fixed only if the specific defect described is clearly gone and nothing equally broken replaced it. If you can't tell, give low confidence.`,
  ]
    .filter(Boolean)
    .join('\n');
  const r = await runAgent({ prompt, tools: ['Read'], allowedTools: ['Read'], addDirs: [runDir, dirname(after.annotated)], jsonSchema: REVIEW_SCHEMA, provider: o.provider, model: o.model ?? null, timeoutMs: 4 * 60_000, transcriptPath: o.transcriptDir ? join(o.transcriptDir, `review-${f.id}.jsonl`) : undefined, agentName: 'fix reviewer' }).catch(() => null);
  const out = r?.ok ? (r.structured as { fixed?: boolean; confidence?: number; reasoning?: string } | null) : null;
  if (!out || typeof out.fixed !== 'boolean') return null;
  return { fixed: out.fixed, confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)), reasoning: String(out.reasoning ?? '').slice(0, 800) };
}

/**
 * After-fix stills of the finding's spot: same steps, browser, size and settings as the "before" evidence, the same
 * element boxed in green (blue at its old position if it's gone). Time-based bugs wait as long as triage did.
 */
export async function captureAfter(f: Finding, file: string, o: { baseUrl: string; guardrails: Config['guardrails']; pool: BrowserPool }) {
  const { steps, browser } = evidenceSteps(f);
  mkdirSync(dirname(file), { recursive: true });
  const { driver } = await replay(steps, { baseUrl: o.baseUrl, browser, initialViewport: f.reproduction.environment.viewport, variant: f.reproduction.environment.variant, guardrails: o.guardrails, pool: o.pool });
  try {
    await settle(driver.page, f.type === 'layout-shift' || f.video ? 2500 : 300);
    // The fix may have changed the element's classes: find it by its text then.
    const selector = (await markTarget(driver.page, f.element)) ?? f.element.selector;
    return await annotateDefect(driver.page, { selector, relatedSelector: null, fallbackBBox: f.element.bbox, label: `${f.id}: after fix`, color: '#00c853', files: { annotated: file, crop: file.replace(/\.png$/, '-crop.png'), full: file.replace(/\.png$/, '-full.png') } });
  } finally {
    await driver.close();
  }
}

/** Narrated after-fix video (same steps and pacing as the "before" one) for time-based or behaviour bugs. */
export async function recordAfterVideo(f: Finding, outDir: string, o: { baseUrl: string; guardrails: Config['guardrails']; pool: BrowserPool }) {
  const { steps, browser } = evidenceSteps(f);
  const v = await recordVideo(steps, {
    id: `${f.id}-after`,
    runDir: outDir,
    title: f.title,
    selector: f.element.selector,
    text: f.element.text,
    relatedSelector: null,
    afterFix: true,
    baseUrl: o.baseUrl,
    browser,
    initialViewport: f.reproduction.environment.viewport,
    variant: f.reproduction.environment.variant,
    guardrails: o.guardrails,
    pool: o.pool,
  });
  return { mp4: v.mp4, gif: v.gif, filmstrip: v.filmstrip };
}

/** Bugs whose behaviour over time matters: they get an after-fix video, not just a still. */
export const needsVideo = (f: Finding) => !!f.video?.mp4 || !!f.video?.webm || f.evidence_kind === 'temporal' || ['layout-shift', 'broken-state'].includes(f.type) || needsGesture(f);

/**
 * Steps (and browser) for after-fix pictures and video. Scroll bugs end with the person's swipes over the element
 * instead of a scripted jump, so the evidence shows what scrolling does now (in Chromium when the finding's browser
 * can't swipe on a phone profile).
 */
export function evidenceSteps(f: Finding): { steps: Step[]; browser: BrowserName } {
  const browser = f.reproduction.environment.browser;
  if (!needsGesture(f)) return { steps: f.reproduction.steps_minimal.length ? f.reproduction.steps_minimal : f.reproduction.steps_original, browser };
  const mobile = !!f.reproduction.environment.variant.device && browser !== 'chromium';
  const swipes: Step[] = Array.from({ length: SWIPES }, () => ({ action: 'swipe' as const, selector: f.element.selector, dy: SWIPE_DY }));
  return { steps: [...gestureSteps(f), ...swipes], browser: mobile ? 'chromium' : browser };
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
