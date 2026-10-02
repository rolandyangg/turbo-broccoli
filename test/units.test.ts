import { describe, it, expect } from 'vitest';
import { clusterFindings, fingerprintOf } from '../src/triage/cluster.js';
import { fitCalibration, calibrate } from '../src/memory/calibration.js';
import { describeStep, normalizeSteps, suffixFromLastGoto } from '../src/triage/steps.js';
import { scanRepo } from '../src/explore/codeIntel.js';
import { pageKey } from '../src/explore/coverage.js';
import { tryParseJson } from '../src/llm/claude.js';
import { RawFinding, Variant, type Step } from '../src/store/schema.js';
import { cleanHtmlUrl, resolveTarget } from '../src/target/resolve.js';

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
    // Run in isolation even when the test process itself was started by a job (it would set these).
    const saved = { dir: process.env.BUGBASH_JOB_DIR, inbox: process.env.BUGBASH_INBOX };
    delete process.env.BUGBASH_JOB_DIR;
    const r = new JobReporter(root, 'fix-1', 'fix', { finding_ids: ['BB-0001'] });
    if (saved.dir !== undefined) process.env.BUGBASH_JOB_DIR = saved.dir;
    if (saved.inbox !== undefined) process.env.BUGBASH_INBOX = saved.inbox;
    else delete process.env.BUGBASH_INBOX;
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

describe('finding categories and focus strategy', () => {
  it('keeps behaviour bugs out of the layout category unless the explorer says otherwise', async () => {
    const { categoryOf } = await import('../src/store/schema.js');
    expect(categoryOf('broken-state')).toBe('ux-functional');
    expect(categoryOf('console-error')).toBe('ux-functional');
    expect(categoryOf('low-contrast')).toBe('layout');
    expect(categoryOf('focus-invisible')).toBe('layout');
  });

  it('maps check_focus to the keyboard strategy so it can be turned off per run', async () => {
    const { strategiesOfCall, STRATEGY_IDS } = await import('../src/explore/strategies.js');
    expect(strategiesOfCall('check_focus', {}, () => null)).toEqual(['chaos.keyboard']);
    for (const id of ['overlay.fit', 'touch.hover-only', 'visual.contrast', 'visual.polish']) expect(STRATEGY_IDS).toContain(id);
  });
});

describe('fix worktree dependencies', () => {
  it('gives the worktree a real node_modules (not a symlink Turbopack rejects), keeping pnpm-style relative links', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, lstatSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { provideDependencies } = await import('../src/fix/fixGroup.js');
    const root = mkdtempSync(join(tmpdir(), 'bb-deps-'));
    const repo = join(root, 'repo');
    const wt = join(root, 'wt');
    mkdirSync(join(repo, 'node_modules', '.pnpm', 'next@16', 'node_modules', 'next'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.pnpm', 'next@16', 'node_modules', 'next', 'package.json'), '{"name":"next"}');
    symlinkSync('.pnpm/next@16/node_modules/next', join(repo, 'node_modules', 'next'));
    mkdirSync(wt);
    const events: string[] = [];
    await provideDependencies(repo, wt, (_s, m) => events.push(m));
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, 'node_modules', 'next')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(wt, 'node_modules', 'next', 'package.json'), 'utf8')).name).toBe('next');
    expect(events.join(' ')).toMatch(/Cloned node_modules/);
  });
});

describe('private workspace', () => {
  it('keeps .bugbash out of git: * in its .gitignore (upgrading old ones) and a local info/exclude entry', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { keepPrivate } = await import('../src/store/store.js');
    const repo = mkdtempSync(join(tmpdir(), 'bb-priv-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const ws = join(repo, '.bugbash');
    mkdirSync(join(ws, 'memory'), { recursive: true });
    mkdirSync(join(ws, 'improvements'), { recursive: true });
    writeFileSync(join(ws, '.gitignore'), 'runs/\ntmp/\njobs/\n'); // the old, too-narrow version
    writeFileSync(join(ws, 'memory', 'lessons.md'), 'x');
    writeFileSync(join(ws, 'improvements', 'r.json'), '{}');
    writeFileSync(join(repo, 'app.css'), 'a{}');
    keepPrivate(ws);
    keepPrivate(ws); // idempotent
    expect(readFileSync(join(ws, '.gitignore'), 'utf8')).toMatch(/^\*$/m);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\/\.bugbash\/$/gm)).toHaveLength(1);
    execFileSync('git', ['add', '-A'], { cwd: repo });
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
    expect(staged).toEqual(['app.css']);
  });
});

describe('PR technical changes section', () => {
  it('lists root cause and per-file what/why with line counts, and never hides a changed file', async () => {
    const { technicalSection } = await import('../src/fix/describe.js');
    const stats = [
      { file: 'app/a.module.css', added: 7, removed: 5 },
      { file: 'app/b.tsx', added: 1, removed: 0 },
    ];
    const t = technicalSection({ commit_subject: 'fix(carousel): let arrows shrink', summary: 'Arrows fit again.', root_cause: 'Fixed width on .arrow.', changes: [
          { file: 'app/a.module.css', what: 'width → min-width', why: 'lets the button shrink' },
          { file: 'a.module.css', what: 'breakpoint 1024 → 1025', why: 'narrow layout at 1024' },
        ], notes: ['Check RTL'] }, stats, 'agent text');
    expect(t.technical.match(/`app\/a\.module\.css`/g)).toHaveLength(1); // two parts, one file entry
    expect(t.technical).toContain('breakpoint 1024 → 1025');
    expect(t.summary).toBe('Arrows fit again.');
    expect(t.technical).toContain('**Root cause.** Fixed width on .arrow.');
    expect(t.technical).toContain('- `app/a.module.css` (+7 −5)\n  - **What:** width → min-width\n    **Why:** lets the button shrink');
    expect(t.technical).toContain('- `app/b.tsx` (+1 −0)'); // not explained, still listed
    expect(t.technical).toContain('**Notes for review**\n- Check RTL');
  });

  it('writes commit messages about the change, with the bug only as a reference', async () => {
    const { commitMessage } = await import('../src/fix/describe.js');
    const msg = commitMessage(
      { commit_subject: 'fix(sponsor-us): start desktop carousel layout at 1025px', summary: 's', root_cause: 'The 1024px media query applied the fixed 900px carousel width at exactly 1024px, pushing the arrows past the viewport edges.', changes: [{ file: 'app/sponsor-us/a.module.css', what: 'Moved the desktop breakpoint to 1025px.', why: 'At 1024px the narrower layout now applies.' }], notes: [] },
      [{ file: 'app/sponsor-us/a.module.css', added: 7, removed: 5 }],
      { fallbackTitle: 'Sponsor Highlights carousel arrows stretched', refs: ['BB-0051', 'BB-0051'], runId: 'r1', verified: true },
    );
    const [subject, blank, ...rest] = msg.split('\n');
    expect(subject).toBe('fix(sponsor-us): start desktop carousel layout at 1025px');
    expect(blank).toBe('');
    expect(msg).not.toMatch(/Sponsor Highlights carousel arrows stretched/); // not the bug title
    expect(rest.join('\n')).toMatch(/^The 1024px media query/);
    expect(msg).toContain('- a.module.css: Moved the desktop breakpoint to 1025px.');
    expect(msg).toContain('Refs: BB-0051 (bugbash run r1)');
    expect(Math.max(...msg.split('\n').filter((l) => !l.startsWith('Co-Authored-By')).map((l) => l.length))).toBeLessThanOrEqual(72);
    // Without an explanation: still about the change (files), never empty.
    expect(commitMessage(null, [{ file: 'x/y.css', added: 1, removed: 1 }], { fallbackTitle: 'Nav overlaps logo', refs: ['BB-1'], runId: 'r', verified: false }).split('\n')[0]).toBe('fix(ui): adjust y.css for nav overlaps logo');
    // A non-conventional subject gets a type.
    expect(commitMessage({ commit_subject: 'Keep arrows in view', summary: '', root_cause: '', changes: [], notes: [] }, [], { fallbackTitle: 't', refs: [], runId: 'r', verified: true }).split('\n')[0]).toBe('fix(ui): Keep arrows in view');
  });

  it('falls back to the changed files and the fix agent summary', async () => {
    const { technicalSection } = await import('../src/fix/describe.js');
    const t = technicalSection(null, [{ file: 'x.css', added: 2, removed: 1 }], 'Agent says: changed x.css');
    expect(t.summary).toBe('Agent says: changed x.css');
    expect(t.technical).toBe('- `x.css` (+2 −1)');
  });
});

describe('messages to running agents', () => {
  it('delivers each new message once per agent at its next tool call, and records who got it', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { postMessage, readMessages, inboxFile } = await import('../src/jobs/inbox.js');
    const dir = mkdtempSync(join(tmpdir(), 'bb-inbox-'));
    const hook = (agent: string) => execFileSync(process.execPath, [join(process.cwd(), 'src/jobs/inboxHook.mjs')], { input: '{}', env: { ...process.env, BUGBASH_INBOX: inboxFile(dir), BUGBASH_AGENT: agent }, encoding: 'utf8' });
    expect(hook('s-001')).toBe(''); // nothing yet
    postMessage(dir, 'Focus on the pricing page');
    const first = JSON.parse(hook('s-001'));
    expect(first.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(first.hookSpecificOutput.additionalContext).toContain('- Focus on the pricing page');
    expect(hook('s-001')).toBe(''); // already delivered to this agent
    expect(JSON.parse(hook('lead')).hookSpecificOutput.additionalContext).toContain('pricing page'); // other agents get it too
    postMessage(dir, 'Also try phones');
    expect(JSON.parse(hook('s-001')).hookSpecificOutput.additionalContext).not.toContain('pricing page'); // only the new one
    expect(readMessages(dir).deliveries.map((d) => d.agent)).toEqual(['s-001', 'lead', 's-001']);
  });
});

describe('fix verification flags', () => {
  const finding = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'overlap', evidence_kind: 'static', video: null, ...extra }) as never;
  it('flags inconclusive, still-present, visual-only, partial checks, missing evidence and regressions', async () => {
    const { verificationFlags } = await import('../src/fix/fixGroup.js');
    const after = [
      { id: 'BB-1', present: null, method: 'none', checks: [], review: null, after: null, verifiable: false },
      { id: 'BB-2', present: false, method: 'visual-review', checks: [], review: { fixed: true, confidence: 0.7, reasoning: '' }, after: null, verifiable: false },
      { id: 'BB-3', present: false, method: 'detector', checks: [{ browser: 'webkit', width: 1280, height: 800, present: null, error: 'replay broke' }, { browser: 'chromium', width: 1280, height: 800, present: false, error: null }], review: null, after: null, verifiable: true },
      { id: 'BB-4', present: true, method: 'detector', checks: [], review: null, after: null, verifiable: true },
    ];
    const ev = new Map<string, never>([
      ['BB-2', { after: { annotated: 'a.png', element_found: false }, after_video: null } as never],
      ['BB-3', { after: { annotated: 'a.png', element_found: true }, after_video: null } as never],
      ['BB-4', { after: { annotated: 'a.png', element_found: true }, after_video: null } as never],
    ]);
    const flags = verificationFlags([finding('BB-1'), finding('BB-2'), finding('BB-3', { type: 'layout-shift' }), finding('BB-4')], after as never, ev, ['/ @320px: new overlap']);
    expect(flags).toEqual([
      "BB-1: couldn't confirm the fix automatically",
      'BB-1: no after-fix screenshot',
      'BB-2: verified only by a visual review (70% confident), not by a detector',
      "BB-2: the after-fix screenshot couldn't find the element, so it shows its old position",
      'BB-3: some checks were inconclusive (webkit 1280px: replay broke)',
      'BB-3: behaviour bug without an after-fix video',
      'BB-4: the bug is still present',
      '1 new layout problem(s) on the pages it touched',
    ]);
  });
});

describe('bug reports', () => {
  it('stores reports per workspace', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { addReport, readReports } = await import('../src/learn/investigate.js');
    const ws = mkdtempSync(join(tmpdir(), 'bb-report-'));
    const r = addReport(ws, { run: 'r1', bug: 'BB-0050', category: 'missed', text: ' Cards cover the What we do text ' });
    expect(r).toMatchObject({ status: 'investigating', text: 'Cards cover the What we do text', proposals: [] });
    expect(readReports(ws).map((x) => x.id)).toEqual([r.id]);
  });
});

describe('improvement checks', () => {
  it('run without the job’s own BUGBASH_* settings', async () => {
    const { cleanEnv } = await import('../src/learn/implement.js');
    process.env.BUGBASH_JOB_DIR = '/tmp/should-not-leak';
    try {
      const env = cleanEnv();
      expect(Object.keys(env).some((k) => k.startsWith('BUGBASH_'))).toBe(false);
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.BUGBASH_JOB_DIR;
    }
  });
});

describe('static target server', () => {
  it('rewrites .html URLs internally instead of redirecting away the query', () => {
    expect(cleanHtmlUrl('/focus.html?ok=1')).toBe('/focus?ok=1');
    expect(cleanHtmlUrl('/anchor.html#terms')).toBe('/anchor#terms');
    expect(cleanHtmlUrl('/index.html?x')).toBe('/?x');
    expect(cleanHtmlUrl('/a/index.html')).toBe('/a/');
    expect(cleanHtmlUrl('/style.css?v=2')).toBe('/style.css?v=2');
  });

  it('serves page.html?query with a 200 and keeps the query', async () => {
    const t = await resolveTarget('fixtures/detector-lab');
    try {
      const r = await fetch(`${t.baseUrl}/focus.html?ok=1`, { redirect: 'manual' });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('<');
      const i = await fetch(`${t.baseUrl}/index.html?x=1`, { redirect: 'manual' });
      expect(i.status).toBe(200);
    } finally {
      await t.stop();
    }
  });
});

describe('dev servers outlive no job', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  it('stops them when the job exits, and sweeps one whose job was killed', async () => {
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execa } = await import('execa');
    const { stopLeftoverServers } = await import('../src/target/resolve.js');
    const home = mkdtempSync(join(tmpdir(), 'bbhome-'));
    const app = mkdtempSync(join(tmpdir(), 'bbapp-'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ scripts: { dev: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"` } }));
    const script = (exit: string) => `import { resolveTarget } from '${join(process.cwd(), 'src/target/resolve.ts')}';\nawait resolveTarget('${app}');\nconsole.log('up');\n${exit}`;
    const env = { ...process.env, BUGBASH_HOME: home };
    const pgidOnRecord = () => JSON.parse(readFileSync(join(home, 'dev-servers', readdirSync(join(home, 'dev-servers'))[0]), 'utf8')).pgid as number;

    // A job that exits (like a cancelled one: SIGTERM handler -> process.exit) takes its dev server with it.
    const run = (body: string) => {
      const f = join(app, `job-${Math.random().toString(36).slice(2)}.mts`);
      writeFileSync(f, body);
      return execa(process.execPath, ['--import', 'tsx', f], { env, reject: false });
    };
    expect((await run(script('process.exit(143);'))).stdout).toContain('up');
    const first = pgidOnRecord();
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(first)).toBe(false);

    // A job killed outright leaves it running; the next start in that folder stops it.
    const job = run(script('setInterval(() => {}, 1000);'));
    await new Promise<void>((r) => job.stdout!.on('data', (d) => String(d).includes('up') && r()));
    const pgid = pgidOnRecord();
    job.kill('SIGKILL');
    await job;
    expect(alive(pgid)).toBe(true);
    process.env.BUGBASH_HOME = home;
    try {
      expect(await stopLeftoverServers(app)).toEqual([pgid]);
    } finally {
      delete process.env.BUGBASH_HOME;
    }
    expect(alive(pgid)).toBe(false);
  }, 60_000);
});

describe('publishing with the saved verification', () => {
  it('turns a saved verification back into the check result the PR body shows', async () => {
    const { savedResult } = await import('../src/fix/fixGroup.js');
    const f = { id: 'BB-0001', fix: { verification: { result: 'inconclusive', method: 'visual-review', checks: [{ browser: 'webkit', width: 390, height: 844, present: null, error: null }], review: { fixed: true, confidence: 0.4, reasoning: 'unsure' }, after: null, after_video: null, at: 'now' } } } as never;
    expect(savedResult(f)).toMatchObject({ id: 'BB-0001', present: null, method: 'visual-review', review: { confidence: 0.4 } });
    const fixed = { id: 'BB-0002', fix: { verification: { result: 'fixed', method: 'detector', checks: [], review: null, after: null, after_video: null, at: 'now' } } } as never;
    expect(savedResult(fixed).present).toBe(false);
  });
});

describe('replaying a finding recorded on a phone', () => {
  it('starts before the device switch, so the switch applies the phone screen size', async () => {
    const { replay, startingVariant, BrowserPool } = await import('../src/triage/replay.js');
    const { Config } = await import('../src/config.js');
    const steps: Step[] = [
      { action: 'resize', width: 1280, height: 800 },
      { action: 'goto', url: '/' },
      { action: 'variant', variant: { device: 'iphone-se' } },
    ];
    expect(startingVariant(steps, { device: 'iphone-se', colorScheme: 'dark' })).toEqual({ colorScheme: 'dark' });
    expect(startingVariant([{ action: 'goto', url: '/' }], { device: 'iphone-se' })).toEqual({ device: 'iphone-se' });
    const t = await resolveTarget('fixtures/detector-lab');
    const pool = new BrowserPool();
    try {
      const { driver, error } = await replay(steps, { baseUrl: t.baseUrl, browser: 'chromium', initialViewport: { width: 1280, height: 800 }, variant: { device: 'iphone-se' }, guardrails: Config.parse({}).guardrails, pool });
      expect(error).toBeNull();
      expect(await driver.page.evaluate(() => [innerWidth, innerHeight < 800, 'ontouchstart' in window])).toEqual([320, true, true]);
      await driver.close();
    } finally {
      await pool.close();
      await t.stop();
    }
  }, 60_000);
});

describe('scroll bugs are verified with a real gesture', () => {
  const steps = (q: string): Step[] => [
    { action: 'goto', url: `/scroll-menu.html${q}` },
    { action: 'variant', variant: { device: 'iphone-se' } },
    { action: 'click', selector: '#open' },
  ];
  it('swipes over the open menu: broken when the page moves and the last link stays out of reach, fine when the menu scrolls', async () => {
    const { replay, BrowserPool } = await import('../src/triage/replay.js');
    const { probeScroll, markTarget } = await import('../src/fix/gesture.js');
    const { Config } = await import('../src/config.js');
    const t = await resolveTarget('fixtures/detector-lab');
    const pool = new BrowserPool();
    const run = (q: string, browser: 'chromium' | 'webkit' = 'chromium', device = true) =>
      replay(device ? steps(q) : steps(q).filter((s) => s.action !== 'variant'), { baseUrl: t.baseUrl, browser, initialViewport: { width: 1280, height: 600 }, variant: device ? { device: 'iphone-se' } : {}, guardrails: Config.parse({}).guardrails, pool });
    try {
      // A selector that a fix broke (class renamed) still finds the element by its text.
      const el = { selector: 'a.renamed-by-the-fix', text: 'AI Hackathon' };
      for (const [q, broken] of [['', true], ['?fixed=1', false]] as const) {
        const { driver } = await run(q);
        expect(await markTarget(driver.page, el)).toBe('[data-bugbash-target="1"]');
        const g = await probeScroll(driver, el);
        await driver.close();
        expect(g.present).toBe(broken);
        if (broken) expect(g.page_moved_px).toBeGreaterThan(20);
        else expect(g).toMatchObject({ reachable: true, page_moved_px: 0 });
        expect(g.container_moved_px > 0).toBe(!broken);
      }
      // Desktop browsers use the mouse wheel; mobile WebKit can't swipe at all (verification switches to Chromium).
      const { driver: desk } = await run('', 'webkit', false);
      expect((await probeScroll(desk, el)).present).toBe(true);
      await desk.close();
      const { driver: phone } = await run('', 'webkit');
      expect(phone.canSwipe).toBe(false);
      await phone.close();
    } finally {
      await pool.close();
      await t.stop();
    }
  }, 120_000);

  it('an overlay bug reported on the menu matches a finding that points at a link inside it', async () => {
    const { replay, checkPresence, BrowserPool } = await import('../src/triage/replay.js');
    const { Config } = await import('../src/config.js');
    const t = await resolveTarget('fixtures/detector-lab');
    const pool = new BrowserPool();
    try {
      for (const [q, want] of [['', 'present'], ['?fixed=1', 'absent']] as const) {
        const { driver } = await replay(steps(q), { baseUrl: t.baseUrl, browser: 'chromium', initialViewport: { width: 1280, height: 600 }, variant: { device: 'iphone-se' }, guardrails: Config.parse({}).guardrails, pool });
        const r = await checkPresence(driver, { type: 'overlay-overflow', selector: '#menu a.last', relatedSelector: null, signature: null });
        await driver.close();
        expect(r.presence).toBe(want);
      }
    } finally {
      await pool.close();
      await t.stop();
    }
  }, 120_000);
});
