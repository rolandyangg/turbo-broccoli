import { chromium, webkit, firefox, type Browser, type BrowserContext, type Page, type BrowserType } from 'playwright';
import type { BrowserName, Step, Variant, Viewport } from '../store/schema.js';
import { Variant as VariantSchema } from '../store/schema.js';
import { Guardrails } from '../mcp/guardrails.js';
import { installDetectors, settle } from '../detect/index.js';
import type { Config } from '../config.js';
import { deviceById, deviceContextOptions } from '../explore/devices.js';

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
  /** When the current context was created (video recording starts here). */
  contextCreatedAt = 0;
  private ownsBrowser = false;

  constructor(readonly opts: DriverOptions) {
    this.guard = new Guardrails(opts.baseUrl, opts.guardrails);
    this.variant = VariantSchema.parse(opts.variant ?? {});
    const dev = deviceById(this.variant.device);
    this.viewport = dev && !opts.viewport ? dev.viewport : opts.viewport;
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
    // Device profile (real touch/mobile emulation) or a plain desktop window of the current size.
    const device = this.variant.device ? deviceContextOptions(this.variant.device, this.opts.browser).options : null;
    if (device?.viewport) this.viewport = { ...device.viewport };
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      deviceScaleFactor: this.variant.dpr !== 1 ? this.variant.dpr : (device?.deviceScaleFactor ?? 1),
      colorScheme: this.variant.colorScheme,
      reducedMotion: this.variant.reducedMotion ? 'reduce' : 'no-preference',
      hasTouch: device?.hasTouch ?? false,
      isMobile: device?.isMobile ?? false,
      userAgent: device?.userAgent,
      recordVideo: this.opts.recordVideoDir ? { dir: this.opts.recordVideoDir, size: this.viewport } : undefined,
      ignoreHTTPSErrors: true,
    });
    this.contextCreatedAt = Date.now();
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

  /** Returns true when the browser context had to be recreated (page state such as open menus is lost). */
  async setVariant(v: Partial<Variant>): Promise<boolean> {
    const next = VariantSchema.parse({ ...this.variant, ...v });
    const needsNewContext = next.dpr !== this.variant.dpr || next.device !== this.variant.device;
    const leavingDevice = this.variant.device && !next.device;
    this.variant = next;
    if (needsNewContext) {
      if (leavingDevice) this.viewport = { width: 1280, height: 800 };
      await this.newContext(this.page.url());
      return true;
    }
    await this.page.emulateMedia({ colorScheme: next.colorScheme, reducedMotion: next.reducedMotion ? 'reduce' : 'no-preference' });
    await this.context.setOffline(next.network === 'offline');
    await this.applyPageVariant();
    await settle(this.page, 150);
    return false;
  }

  /** Execute a recorded step. Guardrails still apply during replay. Resolves true if the context was rebuilt. */
  async apply(step: Step, opts: { timeout?: number } = {}): Promise<boolean | void> {
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
        } else await this.robust(loc, (o) => loc.click(o), 'click', timeout);
        return settle(p, 200);
      }
      case 'hover': {
        const loc = p.locator(step.selector).first();
        await this.robust(loc, (o) => loc.hover(o), 'mouseover', timeout);
        return settle(p, 150);
      }
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
      case 'swipe':
        await this.swipe(step.selector, step.dy);
        return settle(p, 150);
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

  /**
   * Chromium's mobile emulation can leave off-screen elements permanently "unstable" when the page is wider
   * than the device (the layout viewport keeps adjusting). Fall back to scrolling the element into view and
   * acting at its real coordinates, then to dispatching the event directly.
   */
  /** Whether this browser can perform a real swipe here (Playwright has no wheel or swipe in mobile WebKit/Firefox). */
  get canSwipe(): boolean {
    const mobile = !!(this.variant.device && deviceContextOptions(this.variant.device, this.opts.browser).options.isMobile);
    return this.opts.browser === 'chromium' || !mobile;
  }

  /**
   * A person's scroll gesture over `selector` (the visible part of it) or the screen's centre: a real touch swipe in
   * Chromium on touch devices, the mouse wheel elsewhere. It moves whatever a finger there would move.
   */
  async swipe(selector: string | null, dy: number) {
    const p = this.page;
    const vp = p.viewportSize() ?? this.viewport;
    const box = selector ? await p.locator(selector).first().boundingBox().catch(() => null) : null;
    const top = Math.max(0, box?.y ?? 0);
    const bottom = Math.min(vp.height, box ? box.y + box.height : vp.height);
    const x = box ? Math.min(Math.max(box.x + box.width / 2, 5), vp.width - 5) : vp.width / 2;
    const y = bottom > top + 10 ? (top + bottom) / 2 : vp.height / 2;
    if (!this.canSwipe) throw new Error(`Swipe gestures aren't supported in ${this.opts.browser} with a mobile device profile`);
    if (this.opts.browser === 'chromium') {
      const touch = !!(this.variant.device && deviceContextOptions(this.variant.device, this.opts.browser).options.hasTouch);
      const cdp = await this.context.newCDPSession(p);
      await cdp.send('Input.synthesizeScrollGesture', { x, y, yDistance: -dy, gestureSourceType: touch ? 'touch' : 'mouse', speed: 1200 });
      await cdp.detach().catch(() => {});
    } else {
      await p.mouse.move(x, y);
      for (let left = dy; Math.abs(left) > 0; ) {
        const d = Math.sign(left) * Math.min(Math.abs(left), 120);
        await p.mouse.wheel(0, d);
        left -= d;
        await p.waitForTimeout(16);
      }
    }
  }

  private async robust(loc: import('playwright').Locator, act: (o: { timeout: number; force?: boolean }) => Promise<void>, event: string, timeout: number) {
    const quick = this.variant.device ? Math.min(timeout, 2500) : timeout;
    try {
      return await act({ timeout: quick });
    } catch (e) {
      if (!this.variant.device || !/Timeout/i.test(String(e))) throw e;
    }
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
    await this.page.waitForTimeout(150);
    try {
      return await act({ timeout: 2500, force: true });
    } catch {
      await loc.dispatchEvent(event);
    }
  }

  async close() {
    const video = this.page?.video();
    await this.context?.close().catch(() => {});
    if (this.ownsBrowser) await this.browser?.close().catch(() => {});
    return video ? await video.path().catch(() => null) : null;
  }
}
