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
