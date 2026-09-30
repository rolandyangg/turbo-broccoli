import { mkdirSync, renameSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import type { Step } from '../store/schema.js';
import { replay, type ReplayOptions } from './replay.js';
import { describeStep } from './steps.js';

export interface VideoParams {
  paceMs: number; // pause around each step so viewers can follow
  holdMs: number; // hold on the annotated bug
  slowMo: number;
  settleMs: number; // wait after last step for the bug to appear (temporal bugs)
}
export const DEFAULT_VIDEO: VideoParams = { paceMs: 700, holdMs: 1800, slowMo: 60, settleMs: 1500 };

export interface VideoResult {
  webm: string | null;
  mp4: string | null;
  gif: string | null;
  filmstrip: string | null;
  trace: string | null;
  bug_at_ms: number | null;
  frames: string[]; // per-step stills (inputs to the filmstrip)
  bugFrame: string | null;
}

/**
 * Records a narrated replay: caption banner per step, a ring on the element about to be touched,
 * then a labeled box on the defect held for a moment. Also saves a Playwright trace.
 */
export async function recordVideo(
  steps: Step[],
  o: Omit<ReplayOptions, 'recordVideoDir' | 'beforeStep' | 'afterStep' | 'slowMo'> & {
    id: string;
    runDir: string;
    title: string;
    selector: string | null;
    relatedSelector: string | null;
    params?: Partial<VideoParams>;
  },
): Promise<VideoResult> {
  const p = { ...DEFAULT_VIDEO, ...o.params };
  const tmp = join(o.runDir, 'videos', `.tmp-${o.id}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const frames: string[] = [];
  const early: Promise<string | null>[] = [];
  let t0 = 0;
  const caption = (d: import('../replay/driver.js').Driver, text: string) => d.page.evaluate((t) => (window as any).__bugbash?.caption(t), text).catch(() => {});

  const { driver } = await replay(steps, {
    ...o,
    recordVideoDir: tmp,
    slowMo: p.slowMo,
    beforeStep: async (d, step, i) => {
      if (i === 0) {
        t0 = Date.now();
        await d.context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {});
        // Grab a still the moment each page is parsed, before late content shifts it (shows the "before" state).
        d.page.on('domcontentloaded', () => {
          const f = join(tmp, `frame-${String(frames.length).padStart(3, '0')}-load.png`);
          early.push(
            d.page
              .evaluate((t) => (window as any).__bugbash?.caption(t), 'Just after the page loaded')
              .then(() => d.page.screenshot({ path: f }))
              .then(() => f)
              .catch(() => null),
          );
        });
      }
      await caption(d, `Step ${i + 1}/${steps.length}: ${describeStep(step)}`);
      if ('selector' in step && step.selector) await d.page.evaluate((s) => (window as any).__bugbash?.ring(s), step.selector).catch(() => {});
      await d.page.waitForTimeout(p.paceMs / 2);
    },
    afterStep: async (d, step, i) => {
      for (const e of early.splice(0)) {
        const f = await e;
        if (f) frames.push(f);
      }
      await caption(d, `Step ${i + 1}/${steps.length}: ${describeStep(step)}`);
      await d.page.waitForTimeout(p.paceMs / 2);
      const f = join(tmp, `frame-${String(i).padStart(3, '0')}.png`);
      await d.page.screenshot({ path: f }).catch(() => {});
      frames.push(f);
    },
  });

  let bugAt: number | null = null;
  let bugFrame: string | null = null;
  try {
    await driver.page.waitForTimeout(p.settleMs);
    await caption(driver, `BUG: ${o.title}`);
    const shown = await driver.page
      .evaluate(
        ([sel, rel, label]) => {
          const bb = (window as any).__bugbash;
          if (!bb) return false;
          const el = sel && document.querySelector(sel);
          if (el) el.scrollIntoView({ block: 'center' });
          if (rel) bb.drawBox(rel, 'related', '#ff9100');
          return sel ? bb.drawBox(sel, label) : false;
        },
        [o.selector, o.relatedSelector, o.title.slice(0, 60)] as const,
      )
      .catch(() => false);
    bugAt = t0 ? Date.now() - t0 : null;
    bugFrame = join(tmp, 'frame-bug.png');
    await driver.page.screenshot({ path: bugFrame }).catch(() => (bugFrame = null));
    if (bugFrame) frames.push(bugFrame);
    if (!shown) await caption(driver, `BUG (see highlighted area): ${o.title}`);
    await driver.page.waitForTimeout(p.holdMs);
  } finally {
    await driver.context.tracing.stop({ path: join(o.runDir, 'traces', `${o.id}.zip`) }).catch(() => {});
  }
  const webmTmp = await driver.close();
  const base = join(o.runDir, 'videos', o.id);
  let webm: string | null = null;
  if (webmTmp && existsSync(webmTmp)) {
    webm = `${base}.webm`;
    renameSync(webmTmp, webm);
  }
  const result: VideoResult = { webm, mp4: null, gif: null, filmstrip: null, trace: existsSync(join(o.runDir, 'traces', `${o.id}.zip`)) ? join(o.runDir, 'traces', `${o.id}.zip`) : null, bug_at_ms: bugAt, frames, bugFrame };
  if (webm) {
    const mp4 = `${base}.mp4`;
    if ((await ff(['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', mp4])).ok) result.mp4 = mp4;
    const gif = `${base}.gif`;
    const start = Math.max(0, (bugAt ?? 0) / 1000 - 3.5);
    if ((await ff(['-y', '-ss', start.toFixed(2), '-t', '6', '-i', webm, '-vf', 'fps=10,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', gif])).ok) result.gif = gif;
  }
  const strip = frames.slice(-8);
  if (strip.length) {
    const out = `${base}-filmstrip.png`;
    const inputs = strip.flatMap((f) => ['-i', f]);
    const filter = `${strip.map((_, i) => `[${i}:v]scale=360:-2,pad=iw+8:ih:0:0:white[f${i}]`).join(';')};${strip.map((_, i) => `[f${i}]`).join('')}hstack=inputs=${strip.length}`;
    if ((await ff(['-y', ...inputs, '-filter_complex', strip.length > 1 ? filter : `[0:v]scale=360:-2`, '-frames:v', '1', out])).ok) result.filmstrip = out;
  }
  // Keep the bug frame for review; drop the rest of the temp dir.
  if (bugFrame && existsSync(bugFrame)) {
    const keep = `${base}-bugframe.png`;
    renameSync(bugFrame, keep);
    result.bugFrame = keep;
  }
  for (const f of readdirSync(tmp)) rmSync(join(tmp, f), { force: true });
  rmSync(tmp, { recursive: true, force: true });
  result.frames = [];
  return result;
}

async function ff(args: string[]) {
  const r = await execa('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { reject: false });
  return { ok: r.exitCode === 0, err: r.stderr };
}
