import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, webkit, devices, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { resolveTarget, type ResolvedTarget } from '../src/target/resolve.js';
import { installDetectors, runDetectors, settle, landmarks, missingLandmarks, type Candidate, type Landmark } from '../src/detect/index.js';

// Seeded fixture for the focus, overlay, touch and visual-polish detectors (fixtures/detector-lab).
let target: ResolvedTarget;
let cr: Browser;
let wk: Browser;

beforeAll(async () => {
  target = await resolveTarget('fixtures/detector-lab');
  [cr, wk] = await Promise.all([chromium.launch(), webkit.launch()]);
});
afterAll(async () => {
  await Promise.all([cr?.close(), wk?.close()]);
  await target?.stop();
});

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const PHONE: BrowserContextOptions = (() => {
  const { defaultBrowserType: _, ...d } = devices['iPhone 15'];
  return d;
})();

async function at(path: string, opts: BrowserContextOptions = DESKTOP, act?: (p: Page) => Promise<void>, browser = cr): Promise<Candidate[]> {
  const ctx = await browser.newContext(opts);
  await installDetectors(ctx);
  const page = await ctx.newPage();
  await page.goto(target.baseUrl + path);
  await settle(page, 100);
  if (act) await act(page);
  const c = await runDetectors(page);
  await ctx.close();
  return c;
}
const tab = (n: number) => async (p: Page) => {
  for (let i = 0; i < n; i++) await p.keyboard.press('Tab');
  await p.waitForTimeout(80);
};
const has = (c: Candidate[], type: string, sel: RegExp) => c.some((x) => x.type === type && sel.test(`${x.selector} ${x.text}`));

describe('focus & keyboard detectors', () => {
  it('LAB-F1: flags focus with no visible indicator, not a clear focus ring', async () => {
    expect(has(await at('/focus.html', DESKTOP, tab(2)), 'focus-invisible', /no-ring/)).toBe(true);
    expect(has(await at('/focus.html', DESKTOP, tab(1)), 'focus-invisible', /good-ring/)).toBe(false);
  });

  it('LAB-F1 also in WebKit', async () => {
    // WebKit's Tab skips buttons unless "Tab focuses all controls" is on; focus it directly (still :focus-visible).
    const c = await at('/focus.html', DESKTOP, (p) => p.focus('#no-ring'), wk);
    expect(has(c, 'focus-invisible', /no-ring/)).toBe(true);
  });

  it('LAB-F2: flags a focused link hidden under a fixed cookie bar', async () => {
    expect(has(await at('/focus.html', DESKTOP, tab(3)), 'focus-obscured', /deep-link/)).toBe(true);
  });

  it('LAB-F3: flags focus escaping an open modal dialog', async () => {
    const c = await at('/focus.html', DESKTOP, async (p) => {
      await p.evaluate(() => document.getElementById('dlg')!.removeAttribute('hidden'));
      await p.focus('#dlg-ok');
      await p.keyboard.press('Tab');
      await p.waitForTimeout(80);
    });
    expect(has(c, 'focus-escape', /outside/)).toBe(true);
  });

  it('measuring focus does not run the page blur handlers', async () => {
    const ctx = await cr.newContext(DESKTOP);
    await installDetectors(ctx);
    const page = await ctx.newPage();
    await page.goto(target.baseUrl + '/focus.html');
    await page.evaluate(() => {
      (window as unknown as { blurs: number }).blurs = 0;
      document.getElementById('no-ring')!.addEventListener('blur', () => (window as unknown as { blurs: number }).blurs++);
    });
    await tab(2)(page);
    await runDetectors(page);
    expect(await page.evaluate(() => (window as unknown as { blurs: number }).blurs)).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('no-ring');
    await ctx.close();
  });
});

describe('overlay detectors', () => {
  it('LAB-O1: flags a fixed modal taller than a short viewport with no internal scroll', async () => {
    const c = await at('/overlay.html', { viewport: { width: 1280, height: 720 } });
    expect(has(c, 'overlay-overflow', /modal|Terms|agree/i)).toBe(true);
  });

  it('LAB-M1: flags a full-screen hamburger menu that overflows and leaves page scroll unlocked (720px and phone landscape)', async () => {
    const open = (p: Page) => p.click('#burger');
    for (const viewport of [{ width: 1280, height: 720 }, { width: 734, height: 343 }]) {
      const c = await at('/menu.html', { viewport }, open);
      expect(has(c, 'overlay-overflow', /site-nav/)).toBe(true);
      expect(has(c, 'scroll-trap', /site-nav/)).toBe(true);
    }
  });

  it('does not flag a full-screen menu that scrolls internally and locks the page', async () => {
    const c = await at('/menu.html#good', { viewport: { width: 1280, height: 720 } }, (p) => p.click('#burger'));
    expect(has(c, 'overlay-overflow', /site-nav/)).toBe(false);
    expect(has(c, 'scroll-trap', /site-nav/)).toBe(false);
  });

  it('LAB-A1: flags an anchor target landing under a sticky header', async () => {
    expect(has(await at('/anchor.html#terms'), 'hidden-by-sticky', /terms/)).toBe(true);
    expect(has(await at('/anchor.html'), 'hidden-by-sticky', /terms/)).toBe(false);
  });
});

describe('touch-only detectors', () => {
  it('LAB-T1/T2/T3: hover-only menu, overlapping tap targets and a scroll trap on a phone', async () => {
    const c = await at('/touch.html', PHONE);
    expect(has(c, 'hover-only', /account/)).toBe(true);
    expect(has(c, 'overlap', /first|second/)).toBe(true);
    expect(has(c, 'scroll-trap', /feed/)).toBe(true);
  });

  it('does not report touch problems in a desktop window', async () => {
    const c = await at('/touch.html', DESKTOP);
    expect(c.some((x) => ['hover-only', 'scroll-trap'].includes(x.type) || x.metrics.tap_overlap)).toBe(false);
  });
});

describe('visual polish detectors', () => {
  it('LAB-P1..P4: low contrast, distorted image, misaligned card, truncation without a tooltip', async () => {
    const c = await at('/polish.html');
    expect(has(c, 'low-contrast', /faint/)).toBe(true);
    expect(has(c, 'low-contrast', /ok-text/)).toBe(false);
    expect(has(c, 'distorted-image', /squashed/)).toBe(true);
    expect(has(c, 'distorted-image', /fine/)).toBe(false);
    expect(has(c, 'misalignment', /low-card/)).toBe(true);
    expect(has(c, 'truncated-no-tooltip', /#cut\b|cut"?$/)).toBe(true);
    expect(has(c, 'truncated-no-tooltip', /cut-ok/)).toBe(false);
  });

  it('LAB-P1 low contrast is caught in dark mode pages too (computed colours, not the light default)', async () => {
    const c = await at('/polish.html', DESKTOP, async (p) => {
      await p.addStyleTag({ content: 'body { background: #111; color: #eee } .faint { color: #444 }' });
    });
    expect(has(c, 'low-contrast', /faint/)).toBe(true);
    expect(has(c, 'low-contrast', /ok-text/)).toBe(false);
  });
});

describe('primary content across widths', () => {
  // What sweep_viewports does: read the landmarks at each width, then compare neighbouring widths.
  async function sweep(path: string, widths: number[]) {
    const ctx = await cr.newContext(DESKTOP);
    await installDetectors(ctx);
    const page = await ctx.newPage();
    await page.goto(target.baseUrl + path);
    await settle(page, 50);
    const rows: { width: number; marks: Landmark[] }[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      rows.push({ width, marks: await landmarks(page) });
    }
    await ctx.close();
    return missingLandmarks(rows);
  }
  const WIDTHS = [1024, 1100, 1180, 1280, 1440];

  it('LAB-H1: flags the hero heading, CTA and form vanishing at a width where neighbours show them', async () => {
    const found = await sweep('/hero.html', WIDTHS);
    expect(found.map((f) => f.candidate.metrics.landmark).sort()).toEqual(['cta', 'form', 'h1']);
    for (const f of found) {
      expect(f.candidate.type).toBe('broken-state');
      expect(f.widths).toEqual([1180]);
      expect(f.candidate.message).toMatch(/1180px \(display:none\).*1100, 1280px/);
    }
  });

  it('does not flag a hero that is shown at every width', async () => {
    expect(await sweep('/hero.html#good', WIDTHS)).toEqual([]);
  });
});

describe('section collisions and hidden faces', () => {
  it('LAB-S1: text covered by a card section is found even below the fold (whole-page scan)', async () => {
    const c = await at('/sections.html'); // loaded at the top; the collision is a screenful down
    expect(has(c, 'overlap', /covered\b|#covered/)).toBe(true);
    expect(c.find((x) => x.type === 'overlap' && /covered/.test(x.selector ?? ''))?.message).toMatch(/hidden under|card\/panel/i);
  });

  it('does not report text under a real overlay (open menu)', async () => {
    expect(has(await at('/sections.html'), 'overlap', /under-menu/)).toBe(false);
  });

  it('LAB-O1/O2: flags text lines hidden under an opaque element, incl. a 3D flip card (WebKit and Chromium)', async () => {
    for (const browser of [wk, cr]) {
      const c = await at('/occlusion.html', DESKTOP, undefined, browser);
      const flip = c.find((x) => x.type === 'overlap' && x.selector === '#p-3d');
      expect(flip?.metrics.opaque_cover).toBe(true);
      expect(flip?.metrics.hidden_line_share).toBeGreaterThanOrEqual(0.3);
      expect(flip?.related?.selector).toBe('#tracks-3d');
      expect(c.find((x) => x.type === 'overlap' && x.selector === '#p-flat')?.metrics.opaque_cover).toBe(true);
    }
  });

  it('does not count see-through or faded panels as opaque covers', async () => {
    for (const browser of [wk, cr]) {
      const c = await at('/occlusion.html', DESKTOP, undefined, browser);
      expect(c.some((x) => x.type === 'overlap' && /#p-glass|#p-faded/.test(x.selector ?? '') && x.metrics.opaque_cover)).toBe(false);
    }
  });

  it('LAB-S2: a correctly hidden back face is neither "clipped text" nor "mirrored text"', async () => {
    const c = await at('/sections.html');
    expect(has(c, 'text-overflow', /back/)).toBe(false);
    expect(c.some((x) => x.type === 'mirrored-text')).toBe(false);
    expect(has(c, 'broken-state', /back|Front side/)).toBe(false);
  });

  it('LAB-B1/B2: flags a mirrored flip-card face and two faces showing at once, from computed styles (WebKit and Chromium)', async () => {
    for (const browser of [wk, cr]) {
      const c = await at('/flip.html', DESKTOP, undefined, browser);
      expect(c.find((x) => x.type === 'broken-state' && x.selector === '#mirrored-back')?.metrics.mirrored_face).toBe(true);
      expect(c.find((x) => x.type === 'broken-state' && x.selector === '#double')?.metrics.both_faces_visible).toBe(true);
    }
  });

  it('does not flag a flip card whose back face is hidden', async () => {
    for (const browser of [wk, cr]) {
      const c = await at('/flip.html', DESKTOP, undefined, browser);
      expect(has(c, 'broken-state', /ok-|Track one/)).toBe(false);
      expect(has(c, 'broken-state', /mirror-card/)).toBe(false);
    }
  });
});
