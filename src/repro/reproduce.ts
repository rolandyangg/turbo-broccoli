import { Config } from '../config.js';
import { readRun, readFindings, findById } from '../store/store.js';
import { resolveTarget } from '../target/resolve.js';
import { Driver } from '../replay/driver.js';
import { describeStep, suffixFromLastGoto } from '../triage/steps.js';
import { deviceById } from '../explore/devices.js';
import { JobReporter, newJobId } from '../jobs/events.js';
import type { BrowserName, Step } from '../store/schema.js';
import { join } from 'node:path';

export interface ReproduceOptions {
  runDir: string;
  id: string;
  /** full: replay the steps up to the bug; start: only open the page in the bug's environment. */
  mode: 'full' | 'start';
  slow: boolean;
  browser?: BrowserName | null;
  guardrails: boolean;
  jobId?: string | null;
  log: (m: string) => void;
}

/**
 * Opens a real (headed) browser window with the finding's exact environment — engine, device emulation or
 * window size, DPR, color scheme, text scale, network — replays the minimal reproduction with on-page
 * captions, highlights the defect, and then hands the window to the user until they close it.
 */
export async function reproduce(o: ReproduceOptions) {
  const rep = new JobReporter(join(o.runDir, 'jobs'), o.jobId ?? newJobId('reproduce'), 'reproduce', { run_dir: o.runDir, finding_ids: [o.id], scope: o.id, options: { mode: o.mode, slow: o.slow, browser: o.browser ?? null, guardrails: o.guardrails } });
  const say = (stage: string, msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info', data?: Record<string, unknown>) => {
    o.log(msg);
    rep.event(stage, msg, level, data);
  };
  let stop: (() => Promise<void>) | null = null;
  let driver: Driver | null = null;
  const cleanup = async () => {
    await driver?.close().catch(() => {});
    await stop?.().catch(() => {});
  };
  process.on('SIGTERM', async () => {
    await cleanup();
    rep.finish('cancelled', { summary: 'Reproduction window closed from the viewer' });
    process.exit(143);
  });
  try {
    const info = readRun(o.runDir);
    const ff = readFindings(o.runDir);
    const hit = ff && findById(ff, o.id);
    if (!hit) throw new Error(`Unknown finding ${o.id}`);
    const f = hit.finding;
    const env = f.reproduction.environment;
    const browser = o.browser ?? env.browser;
    const config = Config.parse(info.config);

    say('serve', `Starting ${info.target_kind === 'url' ? 'target' : 'the app'} for ${f.id}`);
    const target = await resolveTarget(info.target_kind === 'url' ? info.base_url : (info.repo_path ?? info.target), { repo: info.repo_path, log: (m) => say('serve', m) });
    stop = target.stop;

    const all = f.reproduction.steps_minimal.length ? f.reproduction.steps_minimal : f.reproduction.steps_original;
    // Environment comes from the Driver; replay only what happens on the page.
    // With a device, resizes recorded before the device switch were desktop-window sizes: drop them too.
    let lastDeviceStep = -1;
    all.forEach((s, i) => s.action === 'variant' && 'device' in s.variant && (lastDeviceStep = i));
    const pageSteps = all.filter((s, i) => !(s.action === 'variant' && 'device' in s.variant && Object.keys(s.variant).length === 1) && !(env.variant.device && s.action === 'resize' && i < lastDeviceStep));
    const steps: Step[] = o.mode === 'start' ? suffixFromLastGoto(all).filter((s) => s.action === 'goto').slice(0, 1) : pageSteps;
    const dev = deviceById(env.variant.device);
    say('launch', `Opening ${browser} ${dev ? `as ${dev.label}` : `at ${env.viewport.width}×${env.viewport.height}`}${o.guardrails ? '' : ' (guardrails OFF)'}`, 'info', { browser, device: dev?.label ?? null, viewport: env.viewport, variant: env.variant });
    driver = new Driver({
      browser,
      baseUrl: target.baseUrl,
      viewport: env.viewport,
      variant: env.variant,
      guardrails: o.guardrails ? config.guardrails : { ...config.guardrails, sameOriginOnly: false, allowMutations: true, denylist: '(?!)' },
      headless: false,
      slowMo: o.slow ? 250 : 40,
    });
    await driver.start();
    const d = driver;
    const caption = (t: string) => d.page.evaluate((x) => (window as any).__bugbash?.caption(x), t).catch(() => {});
    const pause = (ms: number) => d.page.waitForTimeout(o.slow ? ms * 2 : ms);

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const label = `Step ${i + 1}/${steps.length}: ${describeStep(s)}`;
      say('step', label, 'info', { index: i, step: s });
      await caption(label);
      if ('selector' in s && s.selector) await d.page.evaluate((sel) => (window as any).__bugbash?.ring(sel), s.selector).catch(() => {});
      await pause(500);
      await d.apply(s).catch((e) => say('step', `Step ${i + 1} failed: ${String(e).split('\n')[0]}`, 'warn'));
      await caption(label);
      await pause(400);
    }

    if (o.mode === 'full') {
      if (f.type === 'layout-shift') await pause(1500);
      const shown = await d.page
        .evaluate(
          ([sel, label]) => {
            const bb = (window as any).__bugbash;
            const el = sel && document.querySelector(sel);
            if (el) el.scrollIntoView({ block: 'center' });
            return bb && sel ? bb.drawBox(sel, label) : false;
          },
          [f.element.selector, `${f.id}: ${f.title.slice(0, 60)}`] as const,
        )
        .catch(() => false);
      await caption(`${f.id}: ${f.title} — ${shown ? 'highlighted in red' : 'see the page'}. This window is yours now; close it when you're done.`);
      say('ready', shown ? `Reproduced: ${f.id} is highlighted. The window stays open until you close it.` : `Steps replayed; the element wasn't found to highlight. The window stays open.`, shown ? 'success' : 'warn');
    } else {
      await caption(`${f.id}: page opened in the bug's environment. Follow the steps in the viewer. Close this window when done.`);
      say('ready', 'Page opened in the bug environment. The window stays open until you close it.', 'success');
    }
    // Remove the caption after a while so it doesn't get in the way of manual testing.
    setTimeout(() => void d.page.evaluate('document.querySelector("[data-bugbash-overlay=caption]")?.remove()').catch(() => {}), 12_000);

    await new Promise<void>((resolve) => {
      d.browser.on('disconnected', () => resolve());
      d.context.on('close', () => resolve());
      d.page.on('close', () => resolve());
    });
    say('closed', 'Window closed');
    await cleanup();
    rep.finish('succeeded', { summary: 'Reproduction window closed' });
  } catch (e) {
    await cleanup();
    rep.finish('failed', { error: (e as Error).message });
    throw e;
  }
}
