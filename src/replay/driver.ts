import { chromium, webkit, firefox, type Browser, type BrowserContext, type Page, type BrowserType } from 'playwright';
import type { BrowserName, Step, Variant, Viewport } from '../store/schema.js';
import { Variant as VariantSchema } from '../store/schema.js';
import { Guardrails } from '../mcp/guardrails.js';
import { installDetectors, settle } from '../detect/index.js';
import type { Config } from '../config.js';

const TYPES: Record<BrowserName, BrowserType> = { chromium, webkit, firefox };

export interface DriverOptions {
  browser: BrowserName;
  baseUrl: string;
  viewport: Viewport;
  variant?: Partial<Variant>;
  guardrails: Config['guardrails'];
  headless?: boolean;
  recordVideoDir?: string | null;
  slowMo?: number;
  sharedBrowser?: Browser;
}

/**
 * Owns a browser context/page plus the emulated environment (viewport + variant) and executes Steps.
 * Used for live exploration (via BrowserSession) and deterministic replay (triage, repro specs, fix verification).
 */
export class Driver {
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;
  guard: Guardrails;
  viewport: Viewport;
  variant: Variant;
  consoleErrors: string[] = [];
  private ownsBrowser = false;

  constructor(readonly opts: DriverOptions) {
    this.guard = new Guardrails(opts.baseUrl, opts.guardrails);
    this.viewport = opts.viewport;
    this.variant = VariantSchema.parse(opts.variant ?? {});
  }

  get browserName(): BrowserName {
    return this.opts.browser;
  }

  async start() {
    if (this.opts.sharedBrowser) this.browser = this.opts.sharedBrowser;
    else {
      this.browser = await TYPES[this.opts.browser].launch({ headless: this.opts.headless ?? true, slowMo: this.opts.slowMo });
      this.ownsBrowser = true;
    }
    await this.newContext();
  }

  private async newContext(url?: string) {
    const old = this.context;
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      deviceScaleFactor: this.variant.dpr,
      colorScheme: this.variant.colorScheme,
      reducedMotion: this.variant.reducedMotion ? 'reduce' : 'no-preference',
      hasTouch: this.viewport.width <= 820 && this.opts.browser !== 'firefox',
      isMobile: false,
      recordVideo: this.opts.recordVideoDir ? { dir: this.opts.recordVideoDir, size: this.viewport } : undefined,
      ignoreHTTPSErrors: true,
    });
    await installDetectors(this.context);
    await this.guard.attach(this.context);
    await this.context.route('**/*', async (route) => {
      const type = route.request().resourceType();
      if (this.variant.blocked.includes(type)) return route.abort('blockedbyclient');
      if (this.variant.network === 'slow-3g') await new Promise((r) => setTimeout(r, 400));
      return route.fallback();
    });
    await this.context.setOffline(this.variant.network === 'offline');
    this.page = await this.context.newPage();
    this.page.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(m.text().slice(0, 300));
    });
    this.page.on('pageerror', (e) => this.consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
    this.page.on('domcontentloaded', () => this.applyPageVariant().catch(() => {}));
    if (old) await old.close().catch(() => {});
    if (url && url !== 'about:blank') await this.goto(url);
  }

  private async applyPageVariant() {
    const css: string[] = [];
    if (this.variant.fontScale !== 1) css.push(`html{font-size:${this.variant.fontScale * 100}% !important}`);
    if (this.variant.zoom !== 1) css.push(`html{zoom:${this.variant.zoom} !important}`);
    await this.page.evaluate(
      ([text, scale]) => {
        let s = document.getElementById('__bugbash_variant');
        if (!text) s?.remove();
        else {
          if (!s) {
            s = document.createElement('style');
            s.id = '__bugbash_variant';
            document.documentElement.appendChild(s);
          }
          s.textContent = text;
        }
        // Text-only zoom: scale every element's computed font size (px-based fonts ignore the root size).
        // The original size is remembered so repeated application doesn't compound.
        const els = Array.from(document.body?.querySelectorAll<HTMLElement>('*') ?? []);
        // Pass 1: record unscaled sizes (before any scaling in this pass, so inheritance doesn't compound).
        for (const el of els) {
          if (el.dataset.bbFs !== undefined || scale === 1) continue;
          const parent = el.parentElement;
          const cur = getComputedStyle(el).fontSize;
          // New element under an already-scaled parent that just inherits: use the parent's base.
          el.dataset.bbFs = parent?.dataset.bbFs && getComputedStyle(parent).fontSize === cur ? parent.dataset.bbFs : cur;
        }
        // Pass 2: apply.
        for (const el of els) {
          if (el.dataset.bbFs === undefined) continue;
          const base = parseFloat(el.dataset.bbFs);
          if (scale === 1) {
            el.style.removeProperty('font-size');
            delete el.dataset.bbFs;
          } else if (base) el.style.setProperty('font-size', `${base * (scale as number)}px`, 'important');
        }
      },
      [css.join('\n'), this.variant.fontScale] as const,
    );
  }

  /** Re-applies text scaling to elements added since the variant was set (called before detection/screenshots). */
  async refreshVariant() {
    if (this.variant.fontScale !== 1) await this.applyPageVariant().catch(() => {});
  }

  abs(url: string) {
    return new URL(url, this.opts.baseUrl + '/').toString();
  }

  path(): string {
    try {
      const u = new URL(this.page.url());
      return u.pathname + u.search + u.hash;
    } catch {
      return this.page.url();
    }
  }

  async goto(url: string) {
    const target = this.abs(url);
    if (!this.guard.isAllowedUrl(target)) throw new Error(`Blocked: ${target} is outside the allowed origin`);
    await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => {
      if (!/ERR_ABORTED|NS_BINDING_ABORTED|blockedbyclient|interrupted/i.test(String(e))) throw e;
    });
    await settle(this.page);
  }

  async resize(width: number, height: number) {
    this.viewport = { width, height };
    await this.page.setViewportSize(this.viewport);
    await settle(this.page, 150);
  }

  async setVariant(v: Partial<Variant>) {
    const next = VariantSchema.parse({ ...this.variant, ...v });
    const needsNewContext = next.dpr !== this.variant.dpr;
    this.variant = next;
    if (needsNewContext) return this.newContext(this.page.url());
    await this.page.emulateMedia({ colorScheme: next.colorScheme, reducedMotion: next.reducedMotion ? 'reduce' : 'no-preference' });
    await this.context.setOffline(next.network === 'offline');
    await this.applyPageVariant();
    await settle(this.page, 150);
  }

  /** Execute a recorded step. Guardrails still apply during replay. */
  async apply(step: Step, opts: { timeout?: number } = {}) {
    const timeout = opts.timeout ?? 5000;
    const p = this.page;
    switch (step.action) {
      case 'goto':
        return this.goto(step.url);
      case 'back':
        await p.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
        return settle(p);
      case 'forward':
        await p.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
        return settle(p);
      case 'reload':
        await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        return settle(p);
      case 'resize':
        return this.resize(step.width, step.height);
      case 'variant':
        return this.setVariant(step.variant);
      case 'click': {
        const loc = p.locator(step.selector).first();
        const n = step.count ?? 1;
        if (n > 1) {
          for (let i = 0; i < n; i++) await loc.click({ timeout, force: i > 0, delay: 0 }).catch(() => {});
        } else await loc.click({ timeout });
        return settle(p, 200);
      }
      case 'hover':
        await p.locator(step.selector).first().hover({ timeout });
        return settle(p, 150);
      case 'fill':
        await p.locator(step.selector).first().fill(step.value, { timeout });
        return settle(p, 100);
      case 'select':
        await p.locator(step.selector).first().selectOption(step.value, { timeout });
        return settle(p, 100);
      case 'press':
        await p.keyboard.press(step.key);
        return settle(p, 100);
      case 'scroll':
        await p.evaluate(([x, y]) => window.scrollTo(x, y), [step.x, step.y]);
        return settle(p, 100);
      case 'mutate_text':
        await p.locator(step.selector).first().evaluate((el, text) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const nodes: Text[] = [];
          let n: Node | null;
          while ((n = walker.nextNode())) if (n.textContent && n.textContent.trim()) nodes.push(n as Text);
          if (nodes.length) {
            nodes[0].textContent = text;
            for (const x of nodes.slice(1)) x.textContent = '';
          } else (el as HTMLElement).textContent = text;
        }, step.text);
        return settle(p, 100);
      case 'wait':
        return p.waitForTimeout(step.ms);
    }
  }

  async close() {
    const video = this.page?.video();
    await this.context?.close().catch(() => {});
    if (this.ownsBrowser) await this.browser?.close().catch(() => {});
    return video ? await video.path().catch(() => null) : null;
  }
}
