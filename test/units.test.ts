import { describe, it, expect } from 'vitest';
import { clusterFindings, fingerprintOf } from '../src/triage/cluster.js';
import { fitCalibration, calibrate } from '../src/memory/calibration.js';
import { describeStep, normalizeSteps, suffixFromLastGoto } from '../src/triage/steps.js';
import { scanRepo } from '../src/explore/codeIntel.js';
import { pageKey } from '../src/explore/coverage.js';
import { tryParseJson } from '../src/llm/claude.js';
import { RawFinding, Variant, type Step } from '../src/store/schema.js';

const raw = (o: Partial<RawFinding> & { selector: string; width: number; session?: string; related?: string }) =>
  RawFinding.parse({
    session: o.session ?? 's-001',
    persona: null,
    type: o.type ?? 'text-overflow',
    title: o.title ?? 'clipped',
    description: '',
    severity: 'major',
    confidence: o.confidence ?? 0.8,
    hypothesis: null,
    strategy: null,
    page: o.page ?? '/pricing',
    url: '/pricing',
    environment: { browser: o.environment?.browser ?? 'chromium', viewport: { width: o.width, height: 800 }, variant: Variant.parse({}) },
    element: { selector: o.selector, text: null, bbox: null, signature: 'div.plan-card > button.cta' },
    detector: o.related ? { type: 'overlap', confidence: 0.8, metrics: { related: { selector: o.related } } } : null,
    trace: [],
    screenshot: null,
    at: new Date().toISOString(),
  });

describe('clustering', () => {
  it('merges the same element across sessions, widths and browsers', () => {
    const c = clusterFindings([
      raw({ selector: 'div.plan-card:nth-of-type(2) > button.cta', width: 320 }),
      raw({ selector: 'div.plan-card:nth-of-type(2) > button.cta', width: 375, session: 's-002', environment: { browser: 'webkit' } as never }),
      raw({ selector: 'div.plan-card:nth-of-type(3) > button.cta', width: 375 }),
    ]);
    expect(c).toHaveLength(2);
    const big = c.find((x) => x.members.length === 2)!;
    expect(big.viewports.map((v) => v.width)).toEqual([320, 375]);
    expect(big.browsers.sort()).toEqual(['chromium', 'webkit']);
  });

  it('treats overlaps as symmetric pairs and overflow types as one family', () => {
    const a = raw({ type: 'overlap', selector: 'span.logo', related: 'nav.nav > a', width: 700 });
    const b = raw({ type: 'overlap', selector: 'nav.nav > a', related: 'span.logo', width: 700 });
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
    expect(fingerprintOf(raw({ type: 'spill-out', selector: 'x', width: 1 }))).toBe(fingerprintOf(raw({ type: 'text-overflow', selector: 'x', width: 1 })));
  });
});

describe('calibration', () => {
  it('is identity when uncalibrated and monotone once fitted', () => {
    expect(calibrate(null, 'overlap', 0.7).value).toBe(0.7);
    const labels = Array.from({ length: 40 }, (_, i) => ({ finding_id: `BB-${i}`, run: 'r', fingerprint: `f${i}`, type: 'overlap', label: (i / 40 > 0.5 ? 'confirmed' : 'false_positive') as 'confirmed' | 'false_positive', raw_confidence: i / 40, note: null, at: '' }));
    const m = fitCalibration(labels);
    expect(m.per_type.overlap).toBeDefined();
    const lo = calibrate(m, 'overlap', 0.2).value;
    const hi = calibrate(m, 'overlap', 0.9).value;
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeLessThan(0.2); // overconfident low scores get pulled down
  });
});

describe('steps', () => {
  const steps: Step[] = [
    { action: 'resize', width: 1280, height: 800 },
    { action: 'goto', url: '/' },
    { action: 'click', selector: 'a.x', text: 'Pricing' },
    { action: 'resize', width: 500, height: 800 },
    { action: 'resize', width: 375, height: 740 },
    { action: 'goto', url: '/pricing' },
    { action: 'click', selector: 'button.buy', text: 'Buy', count: 3 },
  ];
  it('collapses consecutive resizes and keeps env + suffix from last goto', () => {
    expect(normalizeSteps(steps).filter((s) => s.action === 'resize')).toHaveLength(2);
    const sfx = suffixFromLastGoto(steps);
    expect(sfx[0]).toEqual({ action: 'resize', width: 375, height: 740 });
    expect(sfx.map((s) => s.action)).toEqual(['resize', 'goto', 'click']);
  });
  it('describes steps in plain English', () => {
    expect(describeStep(steps[6])).toBe('Click 3 times rapidly on "Buy" (`button.buy`)');
    expect(describeStep({ action: 'variant', variant: { colorScheme: 'dark', fontScale: 2 } })).toBe('Set dark mode, text size 200%');
  });
});

describe('code intel', () => {
  it('finds breakpoints, risky rules and routes in the fixture', () => {
    const ci = scanRepo('fixtures/buggy-site');
    expect(ci.breakpoints).toEqual(expect.arrayContaining([399, 600, 767]));
    expect(ci.risky.some((r) => r.selector.includes('.plan-card .cta') && r.issue.startsWith('fixed height + overflow hidden') && r.maxWidth === 399)).toBe(true);
    expect(ci.risky.some((r) => r.selector.includes('.feature + .feature') && r.issue.startsWith('negative'))).toBe(true);
    expect(ci.routes).toEqual(expect.arrayContaining(['/', '/pricing', '/signup', '/account']));
    expect(ci.hypotheses[0].text).toMatch(/plan-card \.cta/);
  });
});

describe('misc', () => {
  it('normalizes page keys', () => {
    expect(pageKey('/pricing.html?x=1#y')).toBe('/pricing');
    expect(pageKey('/index.html')).toBe('/');
    expect(pageKey('/users/123/edit')).toBe('/users/:id/edit');
  });
  it('extracts JSON from model text', () => {
    expect(tryParseJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseJson('result {"b":[1,2]} done')).toEqual({ b: [1, 2] });
  });
});

describe('structural root-cause fallback', () => {
  it('groups only same type + same full component signature', async () => {
    const { groupFindings } = await import('../src/triage/triage.js');
    const { Finding } = await import('../src/store/schema.js');
    const mk = (id: string, type: string, signature: string) =>
      Finding.parse({ id, fingerprint: id, type, title: id, confidence: 0.9, page: '/', element: { selector: signature, text: null, bbox: null, signature }, reproduction: { environment: { browser: 'chromium', viewport: { width: 320, height: 640 }, variant: Variant.parse({}) } } });
    const groups = await groupFindings(
      [mk('BB-1', 'text-overflow', 'div.plan-card > button.cta'), mk('BB-2', 'text-overflow', 'div.plan-card > button.cta'), mk('BB-3', 'text-overflow', 'span.cart > button.btn'), mk('BB-4', 'broken-state', 'div.dropdown > button.btn')],
      { intel: null, repo: null, model: null, useLlm: false },
    );
    const byMembers = groups.map((g) => g.findings.map((f) => f.id).sort().join(',')).sort();
    expect(byMembers).toEqual(['BB-1,BB-2', 'BB-3', 'BB-4']);
    expect(groups.find((g) => g.findings.length === 2)!.findings[0].siblings).toEqual(['BB-2']);
  });
});

describe('job reporter', () => {
  it('writes status + events and finishes', async () => {
    const { JobReporter, listJobs, describeAgentEvent } = await import('../src/jobs/events.js');
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'bb-jobs-'));
    const r = new JobReporter(root, 'fix-1', 'fix', { finding_ids: ['BB-0001'] });
    r.event('worktree', 'Created branch', 'success', { branch: 'bugbash/x' });
    r.update({ branch: 'bugbash/x' });
    r.event('attempt:1', 'Edit …/src/a.css', 'agent');
    r.finish('succeeded', { verified: true, summary: 'ok' });
    const [j] = listJobs(root);
    expect(j.state).toBe('succeeded');
    expect(j.branch).toBe('bugbash/x');
    expect(j.stage).toBe('done'); // agent events never change the stage
    const events = readFileSync(join(root, 'fix-1', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => e.stage)).toEqual(['worktree', 'attempt:1', 'done']);
    const d = describeAgentEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/styles/app.css' } }, { type: 'text', text: 'Fixed it.' }] } });
    expect(d.map((x) => x.msg)).toEqual(['Edit …/styles/app.css', 'Fixed it.']);
  });
});

describe('personas', () => {
  it('disables low-vision by default and gives everyday personas no editing tools', async () => {
    const { enabledPersonas, EVERYDAY_TOOLS, personaById } = await import('../src/explore/personas.js');
    const { Config } = await import('../src/config.js');
    const ids = enabledPersonas(Config.parse({})).map((p) => p.id);
    expect(ids).not.toContain('low-vision-user');
    expect(ids).toEqual(expect.arrayContaining(['everyday-user', 'phone-user']));
    expect(personaById('everyday-user')!.toolset).toBe('everyday');
    for (const t of ['mutate_text', 'stress_fill', 'set_variant', 'rapid_click', 'block_resources']) expect(EVERYDAY_TOOLS).not.toContain(t);
    expect(EVERYDAY_TOOLS).toEqual(expect.arrayContaining(['click', 'type', 'press', 'set_device', 'sweep_devices']));
  });
});

describe('run names', () => {
  it('sanitises names to one trimmed line and clears empty ones', async () => {
    const { cleanRunName } = await import('../src/store/store.js');
    expect(cleanRunName('  Nightly\n\tpricing  ')).toBe('Nightly pricing');
    expect(cleanRunName('   ')).toBeNull();
    expect(cleanRunName('x'.repeat(200))!.length).toBe(80);
  });
});

describe('presets and strict run selection', () => {
  it('ships built-in presets and saves/deletes user presets', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    process.env.BUGBASH_PRESETS_FILE = join(mkdtempSync(join(tmpdir(), 'bb-presets-')), 'presets.json');
    const { listPresets, savePreset, deletePreset, getPreset, DEFAULT_PRESET } = await import('../src/presets.js');
    const { Config } = await import('../src/config.js');
    expect(listPresets().map((p) => p.id)).toEqual(['standard', 'quick', 'mobile', 'desktop', 'deep']);
    expect(DEFAULT_PRESET).toBe('standard');
    for (const p of listPresets()) expect(() => Config.parse(p.config)).not.toThrow();
    const mine = savePreset({ name: 'My Pricing Sweep', config: { personas: ['phone-user'], budgetSessions: 2 } });
    expect(mine.id).toBe('my-pricing-sweep');
    expect(getPreset('my-pricing-sweep')!.config.budgetSessions).toBe(2);
    const copy = savePreset({ id: 'standard', name: 'Standard', config: {} });
    expect(copy.id).not.toBe('standard'); // built-ins are read-only
    expect(deletePreset('my-pricing-sweep')).toBe(true);
    expect(() => deletePreset('standard')).toThrow();
  });

  it('maps tool calls to strategies so excluded strategies can be refused', async () => {
    const { strategiesOfCall } = await import('../src/explore/strategies.js');
    const { deviceById } = await import('../src/explore/devices.js');
    const kind = (id: string) => deviceById(id)?.kind ?? null;
    expect(strategiesOfCall('mutate_text', {}, kind)).toEqual(['content.label-mutation']);
    expect(strategiesOfCall('set_variant', { network: 'offline', colorScheme: 'dark' }, kind)).toEqual(['env.offline', 'env.dark-mode']);
    expect(strategiesOfCall('stress_fill', { kind: 'realistic' }, kind)).toEqual([]);
    expect(strategiesOfCall('set_device', { device: 'iphone-15' }, kind)).toEqual(['size.devices']);
    expect(strategiesOfCall('set_device', { device: 'laptop' }, kind)).toEqual(['size.desktop-sizes']);
    expect(strategiesOfCall('click', {}, kind)).toEqual([]);
  });

  it('strict campaign: rejects unselected devices/browsers and tracks required persona sessions', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Campaign } = await import('../src/explore/campaign.js');
    const { Config } = await import('../src/config.js');
    const runDir = mkdtempSync(join(tmpdir(), 'bb-camp-'));
    const config = Config.parse({ personas: ['everyday-user', 'phone-user'], personaSessions: { 'phone-user': 2 }, devices: ['iphone-15', 'laptop'], browsers: ['chromium'], strategies: { include: [], exclude: ['env.offline'] } });
    const c = new Campaign({ runId: 'r', runDir, workspace: runDir, baseUrl: 'http://127.0.0.1:1', config, intel: null, log: () => {} });
    expect(c.allowedDevices()).toEqual(['iphone-15', 'laptop']);
    expect(c.excludedStrategies()).toEqual(['env.offline']);
    expect(c.unmetPersonaSessions()).toEqual({ 'phone-user': 2 });
    expect(c.spawn({ goal: 'x', device: 'pixel-7' })).toMatch(/not selected/);
    expect(c.spawn({ goal: 'x', browser: 'webkit' })).toMatch(/not selected/);
    expect(c.spawn({ goal: 'x', persona: 'german-user' })).toMatch(/disabled or unknown/);
    const incOnly = new Campaign({ runId: 'r', runDir, workspace: runDir, baseUrl: 'http://x', config: Config.parse({ strategies: { include: ['size.devices'], exclude: [] } }), intel: null, log: () => {} });
    expect(incOnly.excludedStrategies()).not.toContain('size.devices');
    expect(incOnly.excludedStrategies()).toContain('chaos.rapid-click');
  });
});

describe('pickConfig', () => {
  it('keeps only provided keys (no defaults leak in) and validates them', async () => {
    const { pickConfig } = await import('../src/config.js');
    const r = pickConfig({ maxToolCallsPerSession: 25, strategies: { exclude: ['size.sweep'] } });
    expect(r.ok && Object.keys(r.config).sort()).toEqual(['maxToolCallsPerSession', 'strategies']);
    expect(pickConfig({ parallel: 0 }).ok).toBe(false);
    expect(pickConfig({ nope: 1 }).ok).toBe(false);
  });
});

describe('tool-call telemetry', () => {
  it('appends one tool line per call to the session log', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { BrowserSession } = await import('../src/mcp/session.js');
    const { Config } = await import('../src/config.js');
    const runDir = mkdtempSync(join(tmpdir(), 'bb-tool-'));
    const s = new BrowserSession({ runDir, session: 's-001', baseUrl: 'http://127.0.0.1:1', browser: 'chromium', persona: null, config: Config.parse({}) });
    s.logTool({ name: 'click', ms: 42, ok: true });
    s.logTool({ name: 'resize', ms: 1, ok: false, error: 'refused', blocked: 'selection' });
    const lines = readFileSync(join(runDir, 'sessions', 's-001.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: 'tool', name: 'click', ms: 42, ok: true });
    expect(lines[1]).toMatchObject({ kind: 'tool', name: 'resize', ok: false, blocked: 'selection' });
    expect(typeof lines[0].at).toBe('string');
  });
});
