import type { BrowserContext, Page } from 'playwright';
import type { Config } from '../config.js';

export interface GuardrailEvent {
  kind: 'blocked-click' | 'blocked-navigation' | 'blocked-mutation' | 'dialog-dismissed' | 'popup-closed';
  detail: string;
  at: string;
}

export class Guardrails {
  readonly origin: string;
  readonly allowedOrigins: Set<string>;
  readonly deny: RegExp;
  events: GuardrailEvent[] = [];

  constructor(baseUrl: string, private cfg: Config['guardrails']) {
    this.origin = new URL(baseUrl).origin;
    this.allowedOrigins = new Set([this.origin, ...cfg.extraAllowedOrigins.map((o) => new URL(o).origin)]);
    this.deny = new RegExp(cfg.denylist, 'i');
  }

  private log(kind: GuardrailEvent['kind'], detail: string) {
    this.events.push({ kind, detail, at: new Date().toISOString() });
  }

  isAllowedUrl(url: string): boolean {
    if (!this.cfg.sameOriginOnly) return true;
    try {
      const u = new URL(url, this.origin);
      if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return true;
      return this.allowedOrigins.has(u.origin);
    } catch {
      return false;
    }
  }

  /** Returns a reason string when the element must not be activated. */
  checkActivation(info: { text?: string | null; ariaLabel?: string | null; href?: string | null; value?: string | null; title?: string | null }): string | null {
    const label = [info.text, info.ariaLabel, info.value, info.title].filter(Boolean).join(' ');
    if (label && this.deny.test(label)) return `matches destructive-action denylist ("${label.slice(0, 60)}")`;
    if (info.href) {
      if (/^(mailto|tel|sms|javascript):/i.test(info.href)) return `non-http link (${info.href.slice(0, 40)})`;
      if (!info.href.startsWith('#') && !this.isAllowedUrl(info.href)) return `link leaves the site (${info.href.slice(0, 80)})`;
      if (this.deny.test(info.href)) return `link URL matches denylist (${info.href.slice(0, 80)})`;
    }
    return null;
  }

  noteBlockedClick(detail: string) {
    this.log('blocked-click', detail);
  }

  async attach(context: BrowserContext) {
    await context.route('**/*', async (route) => {
      const req = route.request();
      const isDoc = req.resourceType() === 'document' && req.frame() === req.frame().page().mainFrame();
      if (isDoc && !this.isAllowedUrl(req.url())) {
        this.log('blocked-navigation', req.url());
        return route.abort('blockedbyclient');
      }
      if (req.method() !== 'GET' && req.method() !== 'HEAD' && req.method() !== 'OPTIONS' && !this.cfg.allowMutations && this.isAllowedUrl(req.url())) {
        this.log('blocked-mutation', `${req.method()} ${req.url()}`);
        if (isDoc) return route.abort('blockedbyclient');
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'blocked by bugbash guardrails' }) });
      }
      return route.fallback();
    });
    context.on('page', (p) => this.attachPage(p));
    for (const p of context.pages()) this.attachPage(p);
  }

  private attachPage(page: Page) {
    page.on('dialog', (d) => {
      this.log('dialog-dismissed', `${d.type()}: ${d.message().slice(0, 100)}`);
      d.dismiss().catch(() => {});
    });
    page.on('popup', (p) => {
      this.log('popup-closed', p.url());
      p.close().catch(() => {});
    });
  }

  drain(): GuardrailEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}
