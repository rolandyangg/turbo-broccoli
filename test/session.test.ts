import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTarget, type ResolvedTarget } from '../src/target/resolve.js';
import { BrowserSession } from '../src/mcp/session.js';
import { Driver } from '../src/replay/driver.js';
import { Config } from '../src/config.js';
import { runDetectors } from '../src/detect/index.js';
import { RawFinding } from '../src/store/schema.js';

let target: ResolvedTarget;
const config = Config.parse({});
beforeAll(async () => {
  target = await resolveTarget('fixtures/buggy-site');
});
afterAll(async () => target?.stop());

function newSession(runDir: string, id = 's-001') {
  return new BrowserSession({ runDir, session: id, baseUrl: target.baseUrl, browser: 'chromium', persona: null, config, viewport: { width: 1280, height: 800 } });
}

describe('BrowserSession guardrails', () => {
  it('blocks destructive clicks and off-site links', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bb-'));
    const s = newSession(runDir);
    await s.start();
    await s.goto('/account.html');
    const o = await s.observe({ screenshot: false });
    const delRef = o.text.split('\n').find((l) => /Delete account/.test(l))!.split(' ')[0];
    const extRef = o.text.split('\n').find((l) => /External partner/.test(l))!.split(' ')[0];
    expect(await s.click(delRef)).toMatch(/BLOCKED/);
    expect(await s.click(extRef)).toMatch(/BLOCKED/);
    expect(await s.page.evaluate('document.body.dataset.deleted')).toBeUndefined();
    // Direct navigation off-site is refused too.
    await expect(s.goto('https://example.org/')).rejects.toThrow(/Blocked/);
    await s.close();
  });
});

describe('BrowserSession exploration + replay', () => {
  it('records a finding with a replayable trace (rapid-click cart badge, BUG-06)', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bb-'));
    const s = newSession(runDir);
    await s.start();
    await s.resize(390, 800);
    const o = await s.observe({ screenshot: false });
    const addRef = o.text.split('\n').find((l) => /Add to cart/.test(l))!.split(' ')[0];
    expect(await s.click(addRef, 3)).toMatch(/×3/);
    const det = await s.runDetectors({ only: ['spill-out', 'text-overflow'] });
    const candId = det.split('\n').find((l) => /cart-count/.test(l))?.trim().split(' ')[0];
    expect(candId).toMatch(/^c\d+$/);
    const msg = await s.recordFinding({ type: 'spill-out', title: 'Cart count spills out of badge', description: 'x', severity: 'minor', confidence: 0.9, candidate_id: candId, strategy: 'chaos.rapid-click' });
    expect(msg).toMatch(/Recorded finding/);
    await s.close();

    const lines = readFileSync(join(runDir, 'agent-findings.jsonl'), 'utf8').trim().split('\n');
    const f = RawFinding.parse(JSON.parse(lines[0]));
    expect(f.element.selector).toMatch(/cart-count/);
    expect(existsSync(f.screenshot!)).toBe(true);
    expect(f.trace.some((st) => st.action === 'click' && st.count === 3)).toBe(true);

    // Replay the trace in a fresh browser: the defect must reproduce.
    const d = new Driver({ browser: 'chromium', baseUrl: target.baseUrl, viewport: { width: 1280, height: 800 }, guardrails: config.guardrails });
    await d.start();
    for (const st of f.trace) await d.apply(st);
    const c = await runDetectors(d.page, { only: ['spill-out', 'text-overflow'] });
    expect(c.some((x) => /cart-count/.test(x.selector ?? ''))).toBe(true);
    await d.close();
  });

  it('sweep_viewports finds breakpoint-bound bugs and restores the viewport', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bb-'));
    const s = newSession(runDir);
    await s.start();
    await s.goto('/pricing.html');
    const out = await s.sweepViewports({ widths: [320, 700, 1280] });
    expect(out).toMatch(/text-overflow .*cta/);
    expect(out).toMatch(/viewport-overflow .*compare/);
    expect(s.driver.viewport.width).toBe(1280);
    const cov = JSON.parse(s.coverageReport('/pricing.html'));
    expect(cov[0].widths_tested).toEqual(expect.arrayContaining([320, 700, 1280]));
    expect(cov[0].strategies_untried).not.toContain('size.sweep');
    await s.close();
  });

  it('set_variant dark + fontScale is applied and traced', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bb-'));
    const s = newSession(runDir);
    await s.start();
    await s.setVariant({ colorScheme: 'dark', fontScale: 2 });
    const fs = await s.page.evaluate('getComputedStyle(document.documentElement).fontSize');
    expect(fs).toBe('32px');
    expect(s.trace.some((t) => t.action === 'variant')).toBe(true);
    await s.close();
  });

  it('recovers after the browser context dies, at the same URL and viewport', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bb-'));
    const s = newSession(runDir);
    await s.start();
    await s.goto('/pricing');
    await s.resize(600, 700);
    await s.driver.context.close();
    const msg = await s.recover();
    expect(msg).toMatch(/\/pricing, 600x700/);
    expect((await s.observe({ screenshot: false })).text).toMatch(/URL: \/pricing/);
    await s.close();
  });

  it('set_device emulates a real phone and restores page state (open modal)', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bb-'));
    const s = newSession(runDir);
    await s.start();
    await s.goto('/pricing');
    await s.click('text=Compare plan details');
    const msg = await s.setDevice('iphone-15');
    expect(msg).toMatch(/Emulating iPhone 15/);
    expect(msg).toMatch(/replayed 1 interactions/);
    const env = (await s.page.evaluate(`({ coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, mobileUA: /Mobile/.test(navigator.userAgent), dpr: devicePixelRatio, w: screen.width })`)) as Record<string, unknown>;
    expect(env).toMatchObject({ coarse: true, hoverNone: true, mobileUA: true, dpr: 3, w: 393 });
    expect(await s.page.locator('.modal-backdrop.open').count()).toBe(1); // state survived the context rebuild
    expect(s.trace.some((t) => t.action === 'variant' && t.variant.device === 'iphone-15')).toBe(true);
    const cov = JSON.parse(s.coverageReport('/pricing'));
    expect(cov[0].devices_tested).toContain('iphone-15');
    await s.setDevice('none');
    expect(await s.page.evaluate(`matchMedia('(pointer: coarse)').matches`)).toBe(false);
    await s.close();
  });

  it('sweep_devices catches the table that makes a real phone zoom out', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bb-'));
    const s = newSession(runDir);
    await s.start();
    await s.goto('/pricing');
    const out = await s.sweepDevices({ devices: ['iphone-se', 'pixel-7', 'laptop'] });
    expect(out).toMatch(/viewport-overflow .*compare.*on .*iphone-se/);
    expect(out).toMatch(/zoomed out|wider than the viewport/);
    expect(s.driver.variant.device).toBeNull(); // the session's own page was not changed
    await s.close();
  });

  it('replays a recorded device switch (with state) in a fresh browser', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'bb-'));
    const s = newSession(runDir);
    await s.start();
    await s.goto('/pricing');
    await s.setDevice('iphone-se');
    const trace = [...s.trace];
    await s.close();
    const { replay } = await import('../src/triage/replay.js');
    const { driver } = await replay(trace, { baseUrl: target.baseUrl, browser: 'chromium', initialViewport: { width: 1280, height: 800 }, guardrails: config.guardrails });
    expect(await driver.page.evaluate('innerWidth >= 320 && matchMedia("(pointer: coarse)").matches')).toBe(true);
    const c = await runDetectors(driver.page, { only: ['text-overflow'] });
    expect(c.some((x) => /cta/.test(x.selector ?? ''))).toBe(true);
    await driver.close();
  });
});

describe('check_focus (keyboard focus walk)', () => {
  let lab: ResolvedTarget;
  beforeAll(async () => {
    lab = await resolveTarget('fixtures/detector-lab');
  });
  afterAll(async () => lab?.stop());

  it('walks the tab order, records an invisible-focus finding, and triage replay reproduces it', async () => {
    const { replayAndCheck } = await import('../src/triage/replay.js');
    const runDir = mkdtempSync(join(tmpdir(), 'bb-focus-'));
    const s = new BrowserSession({ runDir, session: 's-001', baseUrl: lab.baseUrl, browser: 'chromium', persona: null, config, viewport: { width: 1280, height: 800 }, startPath: '/focus.html' });
    await s.start();
    const out = await s.checkFocus({ steps: 6 });
    expect(out).toMatch(/Order: .*good-ring.*no-ring/);
    const line = out.split('\n').find((l) => /focus-invisible/.test(l) && /no-ring/.test(l));
    expect(line).toBeTruthy();
    expect(out).toMatch(/focus-obscured .*deep-link/);
    const candId = line!.trim().split(' ')[0];
    expect(await s.recordFinding({ type: 'focus-invisible', title: 'No focus ring on "No focus ring" button', description: 'x', severity: 'major', confidence: 0.9, candidate_id: candId, strategy: 'chaos.keyboard', hypothesis: 'outline:none on buttons hides keyboard focus' })).toMatch(/Recorded finding/);
    await s.close();

    const f = RawFinding.parse(JSON.parse(readFileSync(join(runDir, 'agent-findings.jsonl'), 'utf8').trim().split('\n')[0]));
    expect(f.category).toBe('layout');
    expect(f.trace.filter((st) => st.action === 'press' && st.key === 'Tab').length).toBe(2); // trimmed to the offending stop
    const r = await replayAndCheck(f.trace, { type: f.type, selector: f.element.selector, relatedSelector: null, signature: f.element.signature }, { baseUrl: lab.baseUrl, browser: 'chromium', initialViewport: { width: 1280, height: 800 }, guardrails: config.guardrails });
    expect(r.presence).toBe('present');
  });
});
