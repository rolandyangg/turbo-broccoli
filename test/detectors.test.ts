import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, webkit, type Browser, type Page } from 'playwright';
import { resolveTarget, type ResolvedTarget } from '../src/target/resolve.js';
import { installDetectors, runDetectors, settle, type Candidate } from '../src/detect/index.js';

let target: ResolvedTarget;
let cr: Browser;
let wk: Browser;

beforeAll(async () => {
  target = await resolveTarget('fixtures/buggy-site');
  [cr, wk] = await Promise.all([chromium.launch(), webkit.launch()]);
});
afterAll(async () => {
  await Promise.all([cr?.close(), wk?.close()]);
  await target?.stop();
});

async function detectAt(browser: Browser, path: string, width: number, waitMs = 300): Promise<Candidate[]> {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await installDetectors(ctx);
  const page: Page = await ctx.newPage();
  await page.goto(target.baseUrl + path);
  await settle(page, waitMs);
  const c = await runDetectors(page);
  await ctx.close();
  return c;
}
const has = (c: Candidate[], type: string, sel: RegExp) => c.some((x) => x.type === type && sel.test(`${x.selector} ${x.text} ${x.related?.selector ?? ''}`));

describe('detectors on seeded fixture', () => {
  it('BUG-01: nav overlaps logo between 600 and 767px only', async () => {
    expect(has(await detectAt(cr, '/', 700), 'overlap', /logo|nav/)).toBe(true);
    expect(has(await detectAt(cr, '/', 1280), 'overlap', /logo|nav/)).toBe(false);
  });

  it('BUG-02/03/04: clipped CTA, spilling badge, horizontal scroll on pricing at 360px', async () => {
    const c = await detectAt(cr, '/pricing.html', 360);
    expect(has(c, 'text-overflow', /cta/)).toBe(true);
    expect(has(c, 'spill-out', /badge/)).toBe(true);
    expect(has(c, 'viewport-overflow', /compare/)).toBe(true);
  });

  it('BUG-02 not present on wide screens', async () => {
    expect(has(await detectAt(cr, '/pricing.html', 1280), 'text-overflow', /cta/)).toBe(false);
  });

  it('BUG-05: social icons are tiny and crowded', async () => {
    const c = await detectAt(cr, '/signup.html', 1280);
    expect(has(c, 'small-tap-target', /social/)).toBe(true);
    expect(has(c, 'too-close', /social/)).toBe(true);
  });

  it('BUG-08: late promo banner causes a layout shift (chromium)', async () => {
    expect(has(await detectAt(cr, '/', 1280, 1800), 'layout-shift', /./)).toBe(true);
  });

  it('BUG-08: layout shift is detected in WebKit via position sampling', async () => {
    expect(has(await detectAt(wk, '/', 1280, 2500), 'layout-shift', /./)).toBe(true);
  });

  it('BUG-08: a keypress right before a timer-driven shift does not hide it', async () => {
    const ctx = await cr.newContext({ viewport: { width: 700, height: 900 } });
    await installDetectors(ctx);
    const page = await ctx.newPage();
    await page.goto(target.baseUrl + '/');
    await page.waitForTimeout(900);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1500);
    const c = await runDetectors(page, { only: ['layout-shift'] });
    await ctx.close();
    expect(c.length).toBe(1);
  });

  it('BUG-10: feature cards overlap in WebKit only', async () => {
    expect(has(await detectAt(wk, '/', 1280), 'overlap', /feature/)).toBe(true);
    expect(has(await detectAt(cr, '/', 1280), 'overlap', /feature/)).toBe(false);
  });

  it('control: intentional ellipsis is reported with low confidence and flagged as by-design', async () => {
    const tag = (await detectAt(cr, '/', 1280)).find((x) => /tag/.test(x.selector ?? ''));
    expect(tag).toBeDefined();
    expect(tag!.confidence).toBeLessThanOrEqual(0.35);
    expect(tag!.metrics.truncated_by_design).toBe(true);
  });

  it('control: clean desktop signup page has no high-confidence layout defects beyond the footer', async () => {
    const c = (await detectAt(cr, '/signup.html', 1280)).filter((x) => x.confidence >= 0.6 && !/social|footer/.test(x.selector ?? ''));
    expect(c).toEqual([]);
  });
});

describe('detectors: interaction states', () => {
  it('BUG-07: modal close button over the title on narrow screens', async () => {
    const ctx = await cr.newContext({ viewport: { width: 375, height: 740 } });
    await installDetectors(ctx);
    const page = await ctx.newPage();
    await page.goto(target.baseUrl + '/pricing');
    await page.click('text=Compare plan details');
    await settle(page);
    const c = await runDetectors(page, { only: ['overlap'] });
    await ctx.close();
    expect(has(c, 'overlap', /close|modal/)).toBe(true);
  });

  it('control: an open dropdown menu over content is not an overlap defect', async () => {
    const ctx = await cr.newContext({ viewport: { width: 1280, height: 800 } });
    await installDetectors(ctx);
    const page = await ctx.newPage();
    await page.goto(target.baseUrl + '/');
    await page.evaluate(() => ((document.querySelector('.dropdown-menu') as HTMLElement).style.display = 'block'));
    const c = await runDetectors(page, { only: ['overlap'] });
    await ctx.close();
    expect(c.filter((x) => /dropdown-menu/.test(`${x.selector} ${x.related?.selector}`))).toEqual([]);
  });
});
