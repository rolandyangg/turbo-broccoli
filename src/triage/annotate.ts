import type { Page } from 'playwright';
import type { BBox } from '../store/schema.js';

async function bboxOf(page: Page, selector: string | null): Promise<BBox | null> {
  if (!selector) return null;
  return (await page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    }, selector)
    .catch(() => null)) as BBox | null;
}

/**
 * Draws labeled boxes on the defect (red) and the related element (orange), then writes:
 * annotated viewport screenshot, a cropped close-up, and an annotated full-page screenshot.
 */
export async function annotateDefect(
  page: Page,
  o: { selector: string | null; relatedSelector?: string | null; fallbackBBox?: BBox | null; label: string; files: { annotated: string; crop: string; full: string } },
) {
  const box = (await bboxOf(page, o.selector)) ?? o.fallbackBBox ?? null;
  const rel = await bboxOf(page, o.relatedSelector ?? null);
  if (box) {
    await page.evaluate(([y, h]) => window.scrollTo({ top: Math.max(0, y - (innerHeight - Math.min(h, innerHeight)) / 2), behavior: 'instant' as ScrollBehavior }), [box.y, box.height]);
    await page.waitForTimeout(100);
  }
  await page.evaluate(
    ([b, r, label]) => {
      const bb = (window as any).__bugbash;
      bb.clearOverlay();
      if (r) bb.drawBox(r, 'related', '#ff9100');
      if (b) bb.drawBox(b, label, '#ff1744');
    },
    [box, rel, o.label.slice(0, 70)] as const,
  );
  await page.screenshot({ path: o.files.annotated });
  await page.screenshot({ path: o.files.full, fullPage: true }).catch(() => page.screenshot({ path: o.files.full }));
  if (box) {
    const union = rel ? unionBox(box, rel) : box;
    const size = (await page.evaluate('({w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight})')) as { w: number; h: number };
    const pad = 48;
    const x = Math.max(0, union.x - pad);
    const y = Math.max(0, union.y - pad - 28);
    const clip = { x, y, width: Math.max(40, Math.min(size.w - x, union.width + pad * 2)), height: Math.max(40, Math.min(size.h - y, union.height + pad * 2 + 28, 1200)) };
    await page.screenshot({ path: o.files.crop, clip, fullPage: true }).catch(() => page.screenshot({ path: o.files.crop }));
  } else await page.screenshot({ path: o.files.crop });
  await page.evaluate('window.__bugbash && window.__bugbash.clearOverlay()').catch(() => {});
  return { found: !!box };
}

function unionBox(a: BBox, b: BBox): BBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
