import { writeFileSync, copyFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding, Step } from '../store/schema.js';
import { DETECTABLE } from './replay.js';
import { deviceById } from '../explore/devices.js';

const here = dirname(fileURLToPath(import.meta.url));

function stepCode(s: Step): string {
  const q = JSON.stringify;
  switch (s.action) {
    case 'goto':
      return `await page.goto(BASE + ${q(s.url)});`;
    case 'back':
      return `await page.goBack();`;
    case 'forward':
      return `await page.goForward();`;
    case 'reload':
      return `await page.reload();`;
    case 'resize':
      return `await page.setViewportSize({ width: ${s.width}, height: ${s.height} });`;
    case 'variant': {
      const lines: string[] = [];
      if (s.variant.colorScheme || s.variant.reducedMotion != null) lines.push(`await page.emulateMedia({ ${s.variant.colorScheme ? `colorScheme: ${q(s.variant.colorScheme)}, ` : ''}${s.variant.reducedMotion != null ? `reducedMotion: ${q(s.variant.reducedMotion ? 'reduce' : 'no-preference')}` : ''} });`);
      if (s.variant.fontScale && s.variant.fontScale !== 1) lines.push(`await scaleText(page, ${s.variant.fontScale});`);
      if (s.variant.zoom && s.variant.zoom !== 1) lines.push(`await page.addStyleTag({ content: 'html{zoom:${s.variant.zoom} !important}' });`);
      if (s.variant.network === 'offline') lines.push(`await page.context().setOffline(true);`);
      if (s.variant.device !== undefined) lines.push(`// device switch to ${s.variant.device ?? 'desktop'} happens via test.use() above`);
      return lines.join('\n    ') || '// variant step (no-op in spec)';
    }
    case 'click':
      return s.count && s.count > 1 ? `for (let i = 0; i < ${s.count}; i++) await page.locator(${q(s.selector)}).first().click({ force: i > 0 });` : `await page.locator(${q(s.selector)}).first().click();`;
    case 'hover':
      return `await page.locator(${q(s.selector)}).first().hover();`;
    case 'fill':
      return `await page.locator(${q(s.selector)}).first().fill(${q(s.value)});`;
    case 'select':
      return `await page.locator(${q(s.selector)}).first().selectOption(${q(s.value)});`;
    case 'press':
      return `await page.keyboard.press(${q(s.key)});`;
    case 'scroll':
      return `await page.evaluate(() => window.scrollTo(${s.x}, ${s.y}));`;
    case 'mutate_text':
      return `await page.locator(${q(s.selector)}).first().evaluate((el, t) => { el.textContent = t; }, ${q(s.text)});`;
    case 'wait':
      return `await page.waitForTimeout(${s.ms});`;
  }
}

function deviceUse(env: Finding['reproduction']['environment']): string {
  const dev = deviceById(env.variant.device);
  const scheme = JSON.stringify(env.variant.colorScheme ?? 'light');
  if (dev?.playwright) {
    // Real device emulation (touch, mobile UA, DPR). Firefox has no isMobile.
    const spread = env.browser === 'firefox' ? `...(({ isMobile, defaultBrowserType, ...d }) => d)(devices[${JSON.stringify(dev.playwright)}])` : `...(({ defaultBrowserType, ...d }) => d)(devices[${JSON.stringify(dev.playwright)}])`;
    return `// Device: ${dev.label}\ntest.use({ ${spread}, browserName: ${JSON.stringify(env.browser)}, colorScheme: ${scheme} });`;
  }
  return `test.use({ browserName: ${JSON.stringify(env.browser)}, viewport: { width: ${env.viewport.width}, height: ${env.viewport.height} }, deviceScaleFactor: ${env.variant.dpr ?? 1}, colorScheme: ${scheme} });`;
}

/**
 * Writes repros/<id>.spec.ts: a standalone Playwright test that performs the minimal steps and asserts the
 * defect is absent. It FAILS while the bug exists and passes once it is fixed.
 */
export function writeReproSpec(runDir: string, f: Finding, baseUrl: string): string {
  const dir = join(runDir, 'repros');
  const helper = join(dir, 'bugbash-detectors.js');
  if (!existsSync(helper)) copyFileSync(join(here, '..', 'detect', 'inpage.js'), helper);
  // Make `@playwright/test` resolvable from the repros folder even outside a JS project.
  const nm = join(dir, 'node_modules');
  for (const pkg of ['@playwright', 'playwright', 'playwright-core']) {
    const src = join(here, '..', '..', 'node_modules', pkg);
    if (existsSync(src) && !existsSync(join(nm, pkg))) {
      mkdirSync(nm, { recursive: true });
      try {
        symlinkSync(src, join(nm, pkg), 'dir');
      } catch {}
    }
  }
  if (!existsSync(join(dir, 'playwright.config.mjs')))
    writeFileSync(join(dir, 'playwright.config.mjs'), `// Run: npx playwright test -c ${join(dir, 'playwright.config.mjs')}\nexport default { testDir: '.', timeout: 60000, use: { headless: true } };\n`);
  const env = f.reproduction.environment;
  const steps = f.reproduction.steps_minimal.length ? f.reproduction.steps_minimal : f.reproduction.steps_original;
  const detectable = DETECTABLE.has(f.type);
  const types = f.type === 'text-overflow' || f.type === 'spill-out' ? ['text-overflow', 'spill-out'] : f.type === 'too-close' || f.type === 'small-tap-target' ? ['too-close', 'small-tap-target'] : [f.type];
  const related = (f.metrics?.related as { selector?: string } | undefined)?.selector ?? null;
  const code = `// ${f.id}: ${f.title}
// Generated by bugbash. Fails while the defect exists; passes when it is fixed.
// Environment: ${env.browser} ${env.viewport.width}x${env.viewport.height} ${JSON.stringify(env.variant)}
import { test, expect${deviceById(env.variant.device)?.playwright ? ', devices' : ''} } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BUGBASH_BASE_URL ?? ${JSON.stringify(baseUrl)};

async function scaleText(page, s) {
  await page.evaluate((scale) => { for (const el of document.body.querySelectorAll('*')) { const b = parseFloat(getComputedStyle(el).fontSize); el.style.setProperty('font-size', b * scale + 'px', 'important'); } }, s);
}

${deviceUse(env)}

test(${JSON.stringify(`${f.id} ${f.title}`)}, async ({ page }) => {
  const DETECTORS = readFileSync(join(dirname(test.info().file), 'bugbash-detectors.js'), 'utf8');
  await page.addInitScript({ content: DETECTORS });
  ${steps.map(stepCode).join('\n  ')}
  await page.waitForTimeout(${f.type === 'layout-shift' ? 2500 : 300});
${
  detectable
    ? `  const found = await page.evaluate(() => window.__bugbash.detect({ only: ${JSON.stringify(types)} }));
  const targets = ${JSON.stringify([f.element.selector, related].filter(Boolean))};
  const hits = found.filter((c) => c.confidence >= 0.35 && (${f.type === 'layout-shift' ? 'true' : 'targets.includes(c.selector) || (c.related && targets.includes(c.related.selector))'}));
  expect(hits, 'defect still present: ' + JSON.stringify(hits.map((h) => h.message))).toEqual([]);`
    : `  // Visual-only defect: no geometric detector covers "${f.type}". Assert the element is fully visible and
  // not clipped/overlapped by running every detector scoped to it; review the screenshot manually too.
  const found = await page.evaluate((sel) => window.__bugbash.detect({ scope: sel }).filter((c) => c.confidence >= 0.6), ${JSON.stringify(f.element.selector ?? 'body')});
  expect(found).toEqual([]);`
}
});
`;
  const file = join(dir, `${f.id}.spec.ts`);
  writeFileSync(file, code);
  return file;
}
