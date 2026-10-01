import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Driver } from '../replay/driver.js';
import { runDetectors, settle, temporalSignals, type Candidate } from '../detect/index.js';
import { Coverage, mergeAll, pageKey, summarize } from '../explore/coverage.js';
import { STRATEGIES, STRATEGY_IDS } from '../explore/strategies.js';
import { DEVICE_PROFILES, deviceById, deviceContextOptions } from '../explore/devices.js';
import { suffixFromLastGoto } from '../triage/steps.js';
import { mutatedText, stressValue, STRESS_KINDS, type StressKind } from '../explore/forms.js';
import type { Config } from '../config.js';
import {
  RawFinding,
  Hypothesis,
  type BrowserName,
  type FindingType,
  type Severity,
  type Step,
  type Variant,
} from '../store/schema.js';

export interface SessionOptions {
  runDir: string;
  session: string;
  baseUrl: string;
  browser: BrowserName;
  persona: string | null;
  config: Config;
  startPath?: string;
  viewport?: { width: number; height: number };
  /** Start on this device profile (real touch/mobile emulation or a desktop size). */
  device?: string | null;
  headless?: boolean;
}

interface InteractiveInfo {
  selector: string | null;
  text: string;
  tag: string;
  role: string | null;
  href: string | null;
  type: string | null;
  bbox: { x: number; y: number; width: number; height: number };
  signature: string;
}

interface StoredCandidate {
  id: string;
  candidate: Candidate;
  viewport: { width: number; height: number };
  variant: Variant;
  path: string;
  traceLength: number;
}

const TEMPORAL_TYPES = new Set<FindingType>(['layout-shift', 'broken-state', 'hidden-by-sticky', 'focus-invisible']);

export class BrowserSession {
  driver: Driver;
  trace: Step[] = [];
  refs = new Map<string, string>(); // e12 -> selector
  candidates = new Map<string, StoredCandidate>();
  coverage: Coverage;
  private candCounter = 0;
  private shotCounter = 0;
  private findingsCount = 0;
  private started = false;

  constructor(readonly opts: SessionOptions) {
    this.driver = new Driver({
      browser: opts.browser,
      baseUrl: opts.baseUrl,
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      guardrails: opts.config.guardrails,
      headless: opts.headless ?? true,
    });
    for (const d of ['shots/raw', 'sessions']) mkdirSync(join(opts.runDir, d), { recursive: true });
    this.coverage = new Coverage(opts.runDir, opts.session);
  }

  get page() {
    return this.driver.page;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.driver.start();
    const vp = this.driver.viewport;
    this.record({ action: 'resize', width: vp.width, height: vp.height }, false);
    await this.goto(this.opts.startPath ?? '/');
    if (this.opts.device) await this.setDevice(this.opts.device).catch(() => {});
  }

  /** Tool-call telemetry (name, duration, outcome) for observability. */
  logTool(entry: { name: string; ms: number; ok: boolean; error?: string; blocked?: string }) {
    this.log({ kind: 'tool', ...entry });
  }

  private log(entry: Record<string, unknown>) {
    appendFileSync(join(this.opts.runDir, 'sessions', `${this.opts.session}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  }

  private record(step: Step, apply = true) {
    this.trace.push(step);
    this.log({ kind: 'step', step, applied: apply });
  }

  private tagStrategy(s: string) {
    this.coverage.strategy(this.driver.path(), s);
  }

  private async resolve(ref: string): Promise<string> {
    const sel = this.refs.get(ref) ?? (ref.startsWith('e') && /^e\d+$/.test(ref) ? null : ref);
    if (!sel) throw new Error(`Unknown ref "${ref}". Call observe() to get fresh refs, or pass a CSS selector.`);
    const count = await this.page.locator(sel).count().catch(() => 0);
    if (!count) throw new Error(`Element for ${ref} (${sel}) is not on the page anymore. Call observe() again.`);
    return sel;
  }

  private async guardCheck(selector: string): Promise<string | null> {
    const info = await this.page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const link = el.closest('a');
        return {
          text: ((el as HTMLElement).innerText || el.textContent || '').trim().slice(0, 120),
          ariaLabel: el.getAttribute('aria-label'),
          href: link?.getAttribute('href') ?? null,
          value: (el as HTMLInputElement).value ?? null,
          title: el.getAttribute('title'),
        };
      })
      .catch(() => null);
    if (!info) return null;
    const reason = this.driver.guard.checkActivation(info);
    if (reason) this.driver.guard.noteBlockedClick(`${selector}: ${reason}`);
    return reason;
  }

  private async afterAction(selector?: string) {
    const path = this.driver.path();
    if (selector) this.coverage.tried(path, selector);
    this.coverage.width(path, this.driver.viewport.width, this.driver.viewport.height);
    if (this.driver.variant.device) this.coverage.device(path, this.driver.variant.device);
    this.coverage.browser(path, this.opts.browser);
    this.coverage.flush();
  }

  /**
   * After the browser context is rebuilt (device or DPR change), replay the interactions since the last
   * navigation so the page is back in the same state (open menus, typed input…).
   */
  private async restoreState() {
    const replayable = suffixFromLastGoto(this.trace).filter((st) => st.action !== 'resize' && st.action !== 'variant' && st.action !== 'goto');
    let failed = 0;
    for (const st of replayable) await this.driver.apply(st).catch(() => failed++);
    return failed ? ` (${failed} of ${replayable.length} earlier interactions could not be replayed; call observe())` : replayable.length ? ` (replayed ${replayable.length} interactions to restore the page state)` : '';
  }

  // ---------------- tools ----------------

  async observe(opts: { screenshot?: boolean; maxElements?: number } = {}) {
    await settle(this.page, 100);
    await this.driver.refreshVariant();
    const path = this.driver.path();
    const [items, stateKey, title, aria, shifts] = await Promise.all([
      this.page.evaluate(`window.__bugbash.interactives(${opts.maxElements ?? 150})`) as Promise<InteractiveInfo[]>,
      this.page.evaluate('window.__bugbash.domHash()') as Promise<string>,
      this.page.title().catch(() => ''),
      this.page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => ''),
      this.page.evaluate('window.__bugbash.shifts.filter(s => s.value >= 0.02).length').catch(() => 0) as Promise<number>,
    ]);
    const isNew = this.coverage.state(path, stateKey);
    this.coverage.seen(path, items);
    this.coverage.browser(path, this.opts.browser);
    this.coverage.flush();
    const merged = mergeAll(this.opts.runDir)[pageKey(path)];
    this.refs.clear();
    const lines = items.map((it, i) => {
      const ref = `e${i + 1}`;
      if (it.selector) this.refs.set(ref, it.selector);
      const tried = it.selector && merged?.tried.includes(it.selector) ? ' [tried]' : '';
      const label = it.text || it.href || it.type || '';
      return `${ref} ${it.role ?? it.tag}${it.type ? `[${it.type}]` : ''} "${label.slice(0, 60)}"${it.href ? ` href=${it.href.slice(0, 60)}` : ''} @${it.bbox.x},${it.bbox.y} ${it.bbox.width}x${it.bbox.height}${tried}`;
    });
    const events = this.driver.guard.drain();
    const errors = this.driver.consoleErrors.splice(0);
    const scrollInfo = (await this.page.evaluate('({sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, y: scrollY})')) as { sw: number; sh: number; y: number };
    const text = [
      `URL: ${path}  title: ${title}`,
      `Browser: ${this.opts.browser}  viewport: ${this.driver.viewport.width}x${this.driver.viewport.height}  variant: ${JSON.stringify(this.variantSummary())}`,
      `State: ${stateKey} (${isNew ? 'NEW state' : 'seen before'})  page size: ${scrollInfo.sw}x${scrollInfo.sh} scrollY=${scrollInfo.y}${scrollInfo.sw > this.driver.viewport.width + 1 ? '  ⚠ page scrolls horizontally' : ''}`,
      shifts ? `⚠ ${shifts} layout-shift entries since load` : '',
      errors.length ? `Console errors:\n  ${errors.slice(0, 8).join('\n  ')}` : '',
      events.length ? `Guardrail events:\n  ${events.map((e) => `${e.kind}: ${e.detail}`).join('\n  ')}` : '',
      `Interactive elements (ref role "label" @x,y wxh):`,
      ...lines,
      aria ? `\nAccessibility tree (truncated):\n${aria.slice(0, 3500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const shot = opts.screenshot === false ? null : await this.screenshot();
    this.log({ kind: 'observe', path, stateKey, isNew });
    return { text, screenshot: shot };
  }

  private variantSummary() {
    const v = this.driver.variant;
    const out: Record<string, unknown> = {};
    if (v.device) out.device = v.device;
    if (v.colorScheme !== 'light') out.colorScheme = v.colorScheme;
    if (v.fontScale !== 1) out.fontScale = v.fontScale;
    if (v.zoom !== 1) out.zoom = v.zoom;
    if (v.dpr !== 1) out.dpr = v.dpr;
    if (v.reducedMotion) out.reducedMotion = true;
    if (v.network !== 'online') out.network = v.network;
    if (v.blocked.length) out.blocked = v.blocked;
    return out;
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<{ path: string; base64: string; mime: string }> {
    const file = join(this.opts.runDir, 'shots/raw', `${this.opts.session}-${String(++this.shotCounter).padStart(3, '0')}.jpg`);
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 65, fullPage: opts.fullPage ?? false, path: file });
    return { path: file, base64: buf.toString('base64'), mime: 'image/jpeg' };
  }

  async goto(path: string) {
    await this.driver.goto(path);
    this.record({ action: 'goto', url: this.driver.path() });
    if (path.split('/').filter(Boolean).length > 1) this.tagStrategy('nav.deep-link');
    await this.afterAction();
    return `Navigated to ${this.driver.path()}`;
  }

  async back() {
    await this.driver.apply({ action: 'back' });
    this.record({ action: 'back' });
    this.tagStrategy('nav.back-forward');
    await this.afterAction();
    return `Went back to ${this.driver.path()}`;
  }

  async forward() {
    await this.driver.apply({ action: 'forward' });
    this.record({ action: 'forward' });
    this.tagStrategy('nav.back-forward');
    await this.afterAction();
    return `Went forward to ${this.driver.path()}`;
  }

  async reload() {
    await this.driver.apply({ action: 'reload' });
    this.record({ action: 'reload' });
    this.tagStrategy('nav.reload-mid-flow');
    await this.afterAction();
    return `Reloaded ${this.driver.path()}`;
  }

  async click(ref: string, count = 1) {
    const selector = await this.resolve(ref);
    const blocked = await this.guardCheck(selector);
    if (blocked) return `BLOCKED by guardrails: ${blocked}. Choose a different element.`;
    const before = this.driver.path();
    const step: Step = { action: 'click', selector, count: count > 1 ? count : undefined, text: await this.textOf(selector) };
    await this.driver.apply(step);
    this.record(step);
    if (count > 1) this.tagStrategy('chaos.rapid-click');
    await this.afterAction(selector);
    const after = this.driver.path();
    return `Clicked ${ref}${count > 1 ? ` ×${count}` : ''} (${selector})${after !== before ? ` → navigated to ${after}` : ''}`;
  }

  async hover(ref: string) {
    const selector = await this.resolve(ref);
    const step: Step = { action: 'hover', selector, text: await this.textOf(selector) };
    await this.driver.apply(step);
    this.record(step);
    this.tagStrategy('chaos.hover-transition');
    await this.afterAction(selector);
    return `Hovering ${ref} (${selector})`;
  }

  async type(ref: string, text: string) {
    const selector = await this.resolve(ref);
    const step: Step = { action: 'fill', selector, value: text };
    await this.driver.apply(step);
    this.record(step);
    await this.afterAction(selector);
    return `Filled ${ref} with ${text.length} chars`;
  }

  async stressFill(ref: string, kind: StressKind) {
    const selector = await this.resolve(ref);
    const field = (await this.page
      .locator(selector)
      .first()
      .evaluate((el) => ({ type: el.getAttribute('type'), name: el.getAttribute('name') || el.id, autocomplete: el.getAttribute('autocomplete'), maxLength: (el as HTMLInputElement).maxLength ?? null }))
      .catch(() => ({}))) as Parameters<typeof stressValue>[1];
    const value = stressValue(kind, field);
    const step: Step = { action: 'fill', selector, value };
    await this.driver.apply(step);
    this.record(step);
    const strat = { 'long-word': 'content.long-word', 'long-text': 'content.long-text', 'huge-paste': 'content.huge-paste', emoji: 'content.intl', cjk: 'content.intl', rtl: 'content.intl', zalgo: 'content.intl', german: 'content.long-word', empty: 'content.empty', whitespace: 'content.empty', realistic: null }[kind];
    if (strat) this.tagStrategy(strat);
    await this.afterAction(selector);
    return `Filled ${ref} with ${kind} (${value.length} chars): "${value.slice(0, 60)}${value.length > 60 ? '…' : ''}"`;
  }

  async select(ref: string, value: string) {
    const selector = await this.resolve(ref);
    const step: Step = { action: 'select', selector, value };
    await this.driver.apply(step);
    this.record(step);
    await this.afterAction(selector);
    return `Selected "${value}" in ${ref}`;
  }

  async press(key: string) {
    const step: Step = { action: 'press', key };
    await this.driver.apply(step);
    this.record(step);
    if (/Tab|Escape|Enter|Arrow/.test(key)) this.tagStrategy('chaos.keyboard');
    await this.afterAction();
    const focused = await this.page.evaluate('document.activeElement && document.activeElement !== document.body ? window.__bugbash.selectorFor(document.activeElement) : null');
    return `Pressed ${key}. Focus: ${focused ?? 'body'}`;
  }

  async scroll(to: 'top' | 'bottom' | 'right' | 'left' | { x: number; y: number }) {
    const pos = (await this.page.evaluate((t) => {
      const d = document.documentElement;
      if (t === 'top') return { x: scrollX, y: 0 };
      if (t === 'bottom') return { x: scrollX, y: d.scrollHeight };
      if (t === 'right') return { x: d.scrollWidth, y: scrollY };
      if (t === 'left') return { x: 0, y: scrollY };
      return t as { x: number; y: number };
    }, to)) as { x: number; y: number };
    const step: Step = { action: 'scroll', x: pos.x, y: pos.y };
    await this.driver.apply(step);
    this.record(step);
    this.tagStrategy('chaos.scroll-extremes');
    await this.afterAction();
    return `Scrolled to ${JSON.stringify(pos)}`;
  }

  async resize(width: number, height?: number) {
    const h = height ?? this.driver.viewport.height;
    const hasOverlay = (await this.page.evaluate('!!document.querySelector("[role=dialog]:not([hidden]), dialog[open], [aria-expanded=true]")').catch(() => false)) as boolean;
    await this.driver.resize(width, h);
    this.record({ action: 'resize', width, height: h });
    if (hasOverlay) this.tagStrategy('size.resize-with-overlay');
    await this.afterAction();
    return `Viewport is now ${width}x${h}`;
  }

  async setDevice(id: string | null) {
    const dev = id && id !== 'none' ? deviceById(id) : null;
    if (id && id !== 'none' && !dev) return `Unknown device "${id}". Available: ${DEVICE_PROFILES.map((d) => d.id).join(', ')}`;
    const notes = dev?.playwright ? deviceContextOptions(dev.id, this.opts.browser).notes : [];
    if (!dev?.playwright && dev) {
      // Desktop profiles are plain window sizes: resize, no context rebuild.
      if (this.driver.variant.device) await this.driver.setVariant({ device: null });
      await this.resize(dev.viewport.width, dev.viewport.height);
      this.tagStrategy('size.desktop-sizes');
      return `Desktop window ${dev.label}: ${dev.viewport.width}x${dev.viewport.height} (mouse + keyboard).`;
    }
    const recreated = await this.driver.setVariant({ device: dev?.id ?? null });
    this.record({ action: 'variant', variant: { device: dev?.id ?? null } });
    const restored = recreated ? await this.restoreState() : '';
    if (dev) this.tagStrategy('size.devices');
    await this.afterAction();
    const vp = this.driver.viewport;
    return dev
      ? `Emulating ${dev.label}: ${vp.width}x${vp.height}, touch (no hover), mobile UA, DPR ${this.page.viewportSize() ? (await this.page.evaluate('devicePixelRatio')) : '?'}${restored}.${notes.length ? ' Note: ' + notes.join(' ') : ''}`
      : `Back to a desktop window ${vp.width}x${vp.height}${restored}.`;
  }

  async setVariant(v: Partial<Variant>) {
    const recreated = await this.driver.setVariant(v);
    if (recreated) await this.restoreState();
    this.record({ action: 'variant', variant: v });
    const path = this.driver.path();
    if (v.colorScheme === 'dark') (this.coverage.variant(path, 'dark'), this.tagStrategy('env.dark-mode'));
    if (v.fontScale && v.fontScale !== 1) (this.coverage.variant(path, `font${v.fontScale}`), this.tagStrategy('content.font-scale'));
    if (v.zoom && v.zoom !== 1) (this.coverage.variant(path, `zoom${v.zoom}`), this.tagStrategy('content.zoom'));
    if (v.dpr && v.dpr !== 1) (this.coverage.variant(path, `dpr${v.dpr}`), this.tagStrategy('env.dpr'));
    if (v.reducedMotion) (this.coverage.variant(path, 'reduced-motion'), this.tagStrategy('env.reduced-motion'));
    if (v.network && v.network !== 'online') (this.coverage.variant(path, v.network), this.tagStrategy('env.offline'));
    if (v.blocked?.length) (this.coverage.variant(path, `blocked:${v.blocked.join(',')}`), this.tagStrategy('env.block-resources'));
    await this.afterAction();
    return `Variant now ${JSON.stringify(this.variantSummary())}`;
  }

  async mutateText(ref: string, opts: { factor?: number; locale?: string; text?: string }) {
    const selector = await this.resolve(ref);
    const original = await this.textOf(selector);
    const text = opts.text ?? mutatedText(original ?? '', opts.factor ?? 2.5, opts.locale);
    const step: Step = { action: 'mutate_text', selector, text };
    await this.driver.apply(step);
    this.record(step);
    this.tagStrategy('content.label-mutation');
    await this.afterAction(selector);
    return `Replaced text of ${ref}: "${(original ?? '').slice(0, 40)}" → "${text.slice(0, 80)}"`;
  }

  async findSimilar(ref: string) {
    const selector = await this.resolve(ref);
    const info = (await this.page.evaluate(`window.__bugbash.elementInfo(${JSON.stringify(selector)})`)) as { signature: string } | null;
    if (!info) return 'Element not found';
    const matches = (await this.page.evaluate(`window.__bugbash.findBySignature(${JSON.stringify(info.signature)})`)) as { selector: string; text: string }[];
    return `Signature "${info.signature}" matches ${matches.length} element(s) on this page:\n${matches.map((m) => `  ${m.selector} "${m.text.slice(0, 50)}"`).join('\n')}`;
  }

  private storeCandidates(cands: Candidate[]) {
    return cands.map((c) => {
      const id = `c${++this.candCounter}`;
      this.candidates.set(id, { id, candidate: c, viewport: { ...this.driver.viewport }, variant: { ...this.driver.variant }, path: this.driver.path(), traceLength: this.trace.length });
      return { id, c };
    });
  }

  private detectOpts(only?: string[] | null, scope?: string | null) {
    const d = this.opts.config.detectors;
    return { minGapPx: d.minGapPx, minTapTargetPx: d.minTapTargetPx, edgePaddingPx: d.edgePaddingPx, only: only ?? null, scope: scope ?? null };
  }

  async runDetectors(opts: { only?: string[]; scope?: string; minConfidence?: number } = {}) {
    await this.driver.refreshVariant();
    const cands = (await runDetectors(this.page, this.detectOpts(opts.only, opts.scope))).filter((c) => c.confidence >= (opts.minConfidence ?? 0));
    this.coverage.width(this.driver.path(), this.driver.viewport.width, this.driver.viewport.height);
    if (this.driver.variant.device) this.coverage.device(this.driver.path(), this.driver.variant.device);
    this.coverage.flush();
    const stored = this.storeCandidates(cands);
    if (!stored.length) return `No detector candidates at ${this.driver.viewport.width}x${this.driver.viewport.height}.`;
    return `Detector candidates at ${this.driver.viewport.width}x${this.driver.viewport.height} (verify visually before recording):\n` + stored.map(({ id, c }) => `  ${id} ${c.type} conf=${c.confidence} ${c.selector} "${c.text.slice(0, 40)}" — ${c.message}${c.related ? ` [with ${c.related.selector}]` : ''}`).join('\n');
  }

  async sweepViewports(opts: { widths?: number[]; height?: number; minConfidence?: number } = {}) {
    const widths = opts.widths?.length ? opts.widths : this.opts.config.viewports.widths;
    const height = opts.height ?? this.driver.viewport.height;
    const orig = { ...this.driver.viewport };
    const agg = new Map<string, { ids: string[]; widths: number[]; c: Candidate }>();
    for (const w of widths) {
      await this.driver.resize(w, height);
      this.coverage.width(this.driver.path(), w, height);
      const cands = (await runDetectors(this.page, this.detectOpts())).filter((c) => c.confidence >= (opts.minConfidence ?? 0.4));
      for (const { id, c } of this.storeCandidates(cands)) {
        const key = `${c.type}|${c.selector}`;
        const a = agg.get(key) ?? { ids: [], widths: [], c };
        a.ids.push(id);
        a.widths.push(w);
        if (c.confidence > a.c.confidence) a.c = c;
        agg.set(key, a);
      }
    }
    await this.driver.resize(orig.width, orig.height);
    this.tagStrategy('size.sweep');
    this.coverage.flush();
    if (!agg.size) return `Swept ${widths.length} widths (${widths.join(', ')}) at height ${height}: no candidates.`;
    const rows = [...agg.values()].sort((a, b) => b.c.confidence - a.c.confidence);
    // Every candidate id from a sweep row remembers all widths where it occurred.
    for (const r of rows) for (const id of r.ids) this.candidates.get(id)!.candidate.metrics.widths = r.widths;
    return (
      `Swept ${widths.length} widths at height ${height}; viewport restored to ${orig.width}x${orig.height}. Candidates (use the listed candidate id — its viewport is applied automatically when recording):\n` +
      rows.map((r) => `  ${r.ids[0]} ${r.c.type} conf=${r.c.confidence} ${r.c.selector} "${r.c.text.slice(0, 40)}" at widths ${compressRanges(r.widths)} — ${r.c.message}${r.c.related ? ` [with ${r.c.related.selector}]` : ''}`).join('\n')
    );
  }

  /**
   * Re-renders the current page state on real device profiles (each in its own temporary context, replaying the
   * interactions since the last navigation) and runs the detectors there. The session's own page is untouched.
   */
  async sweepDevices(opts: { devices?: string[]; minConfidence?: number } = {}) {
    const ids = (opts.devices?.length ? opts.devices : DEVICE_PROFILES.filter((d) => d.kind !== 'desktop').map((d) => d.id)).filter((id) => deviceById(id));
    const path = this.driver.path();
    const replay = suffixFromLastGoto(this.trace).filter((st) => st.action !== 'resize' && st.action !== 'variant' && st.action !== 'goto');
    const agg = new Map<string, { ids: string[]; devices: string[]; c: Candidate }>();
    const skipped: string[] = [];
    for (const id of ids) {
      const dev = deviceById(id)!;
      const temp = new Driver({ browser: this.opts.browser, baseUrl: this.opts.baseUrl, viewport: dev.viewport, variant: { ...this.driver.variant, device: dev.playwright ? dev.id : null }, guardrails: this.opts.config.guardrails, sharedBrowser: this.driver.browser });
      try {
        await temp.start();
        await temp.goto(path);
        for (const st of replay) await temp.apply(st).catch(() => {});
        await temp.refreshVariant();
        const cands = (await runDetectors(temp.page, this.detectOpts())).filter((c) => c.confidence >= (opts.minConfidence ?? 0.4));
        this.coverage.width(path, temp.viewport.width, temp.viewport.height);
        if (dev.playwright) this.coverage.device(path, dev.id);
        for (const c of cands) {
          const cid = `c${++this.candCounter}`;
          this.candidates.set(cid, { id: cid, candidate: c, viewport: { ...temp.viewport }, variant: { ...temp.variant }, path, traceLength: this.trace.length });
          const key = `${c.type}|${c.selector}`;
          const a = agg.get(key) ?? { ids: [], devices: [], c };
          a.ids.push(cid);
          a.devices.push(dev.id);
          if (c.confidence > a.c.confidence) a.c = c;
          agg.set(key, a);
        }
      } catch (e) {
        skipped.push(`${id}: ${(e as Error).message.split('\n')[0]}`);
      } finally {
        await temp.context?.close().catch(() => {});
      }
    }
    this.tagStrategy('size.devices');
    this.coverage.flush();
    const head = `Rendered ${path} on ${ids.length} device profile(s) (${ids.join(', ')}) in ${this.opts.browser}${replay.length ? `, replaying ${replay.length} interactions` : ''}. Your own page was not changed.`;
    const rows = [...agg.values()].sort((a, b) => b.c.confidence - a.c.confidence);
    return (
      head +
      (skipped.length ? `\nSkipped: ${skipped.join('; ')}` : '') +
      (rows.length
        ? `\nCandidates (recording one switches your session to that device automatically):\n` + rows.map((r) => `  ${r.ids[0]} ${r.c.type} conf=${r.c.confidence} ${r.c.selector} "${r.c.text.slice(0, 40)}" on ${r.devices.join(', ')} — ${r.c.message}${r.c.related ? ` [with ${r.c.related.selector}]` : ''}`).join('\n')
        : '\nNo detector candidates on these devices.')
    );
  }

  async annotatedScreenshot(bbox: { x: number; y: number; width: number; height: number } | null, label: string, file: string) {
    if (bbox) {
      await this.page.evaluate(([y, h]) => window.scrollTo({ top: Math.max(0, y - (innerHeight - h) / 2), behavior: 'instant' as ScrollBehavior }), [bbox.y, bbox.height]);
      await this.page.evaluate(([b, l]) => (window as any).__bugbash.drawBox(b, l), [bbox, label] as const);
    }
    await this.page.screenshot({ path: file, type: 'png' });
    await this.page.evaluate('window.__bugbash.clearOverlay()').catch(() => {});
  }

  async recordFinding(input: {
    type: FindingType;
    title: string;
    description: string;
    severity: Severity;
    confidence: number;
    candidate_id?: string;
    ref?: string;
    hypothesis?: string;
    strategy?: string;
    seeded_by_code_intel?: boolean;
    temporal?: boolean;
  }) {
    let cand: StoredCandidate | undefined;
    if (input.candidate_id) {
      cand = this.candidates.get(input.candidate_id);
      if (!cand) return `Unknown candidate_id ${input.candidate_id}.`;
      // Reproduce the environment the candidate was seen in.
      if ((cand.variant.device ?? null) !== (this.driver.variant.device ?? null)) await this.setDevice(cand.variant.device ?? 'none');
      if (cand.viewport.width !== this.driver.viewport.width || cand.viewport.height !== this.driver.viewport.height) await this.resize(cand.viewport.width, cand.viewport.height);
    }
    let element: RawFinding['element'] = { selector: null, text: null, bbox: null, signature: null };
    const sel = cand?.candidate.selector ?? (input.ref ? await this.resolve(input.ref).catch(() => null) : null);
    if (sel) {
      const info = (await this.page.evaluate(`window.__bugbash.elementInfo(${JSON.stringify(sel)})`).catch(() => null)) as RawFinding['element'] | null;
      element = info ? { selector: info.selector, text: info.text, bbox: info.bbox, signature: info.signature } : { selector: sel, text: cand?.candidate.text ?? null, bbox: cand?.candidate.bbox ?? null, signature: cand?.candidate.signature ?? null };
    }
    const n = ++this.findingsCount;
    const shot = join(this.opts.runDir, 'shots/raw', `${this.opts.session}-finding-${n}.png`);
    await this.annotatedScreenshot(element.bbox, input.title.slice(0, 60), shot);
    const temporal = input.temporal || TEMPORAL_TYPES.has(input.type) ? await temporalSignals(this.page) : [];
    const raw = RawFinding.parse({
      session: this.opts.session,
      persona: this.opts.persona,
      type: input.type,
      title: input.title,
      description: input.description,
      severity: input.severity,
      confidence: input.confidence,
      hypothesis: input.hypothesis ?? null,
      strategy: input.strategy ?? null,
      seeded_by_code_intel: input.seeded_by_code_intel ?? false,
      page: pageKey(this.driver.path()),
      url: this.driver.path(),
      environment: { browser: this.opts.browser, viewport: this.driver.viewport, variant: this.driver.variant, persona: this.opts.persona ?? undefined },
      element,
      detector: cand ? { type: cand.candidate.type, confidence: cand.candidate.confidence, metrics: { ...cand.candidate.metrics, message: cand.candidate.message, related: cand.candidate.related } } : null,
      temporal_signals: temporal,
      trace: [...this.trace],
      screenshot: shot,
      at: new Date().toISOString(),
    });
    appendFileSync(join(this.opts.runDir, 'agent-findings.jsonl'), JSON.stringify(raw) + '\n');
    if (input.strategy && (STRATEGY_IDS as string[]).includes(input.strategy)) this.tagStrategy(input.strategy);
    this.coverage.flush();
    this.log({ kind: 'finding', title: input.title, type: input.type });
    return `Recorded finding #${n} "${input.title}" (${input.type}, ${input.severity}, conf ${input.confidence}) on ${raw.page} at ${raw.environment.viewport.width}x${raw.environment.viewport.height} [${this.opts.browser}]${temporal.length ? ` temporal signals: ${temporal.join(', ')}` : ''}.`;
  }

  logHypothesis(input: { hypothesis: string; strategy?: string; outcome: 'confirmed' | 'refuted' | 'inconclusive'; note?: string }) {
    const h = Hypothesis.parse({ session: this.opts.session, page: pageKey(this.driver.path()), hypothesis: input.hypothesis, strategy: input.strategy ?? null, outcome: input.outcome, note: input.note ?? '', at: new Date().toISOString() });
    appendFileSync(join(this.opts.runDir, 'hypotheses.jsonl'), JSON.stringify(h) + '\n');
    if (input.strategy && (STRATEGY_IDS as string[]).includes(input.strategy)) {
      this.tagStrategy(input.strategy);
      this.coverage.flush();
    }
    return `Logged hypothesis (${input.outcome}).`;
  }

  coverageReport(page?: string) {
    const all = summarize(mergeAll(this.opts.runDir), this.opts.config.viewports.widths, this.opts.config.browsers);
    const rows = page ? all.filter((r) => r.page === pageKey(page)) : all;
    return JSON.stringify(rows.slice(0, 15), null, 1);
  }

  strategyCoverage() {
    const pc = mergeAll(this.opts.runDir)[pageKey(this.driver.path())];
    const done = new Set(pc?.strategies ?? []);
    return `Strategies on ${pageKey(this.driver.path())}:\n` + STRATEGY_IDS.map((s) => `  [${done.has(s) ? 'x' : ' '}] ${s} — ${STRATEGIES[s]}`).join('\n');
  }

  notes(action: 'read' | 'write', text?: string) {
    const f = join(this.opts.runDir, 'notes.md');
    if (action === 'write' && text) {
      appendFileSync(f, `- [${this.opts.session}/${this.opts.persona ?? 'default'}/${this.opts.browser}] ${text.replace(/\n/g, ' ')}\n`);
      return 'Note saved.';
    }
    return existsSync(f) ? readFileSync(f, 'utf8').slice(-6000) : '(no notes yet)';
  }

  private async textOf(selector: string) {
    return this.page
      .locator(selector)
      .first()
      .evaluate((el) => ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80))
      .catch(() => undefined);
  }

  /** Relaunch after a crash: fresh browser/context at the same URL, viewport and variant (recorded in the trace). */
  async recover(): Promise<string> {
    let url = '/';
    try {
      url = this.driver.path();
    } catch {}
    const vp = { ...this.driver.viewport };
    const variant = { ...this.driver.variant };
    await this.driver.close().catch(() => {});
    this.driver = new Driver({ browser: this.opts.browser, baseUrl: this.opts.baseUrl, viewport: vp, variant, guardrails: this.opts.config.guardrails, headless: this.opts.headless ?? true });
    await this.driver.start();
    await this.driver.goto(url.startsWith('/') ? url : '/');
    this.record({ action: 'goto', url: this.driver.path() });
    this.log({ kind: 'recovered', url });
    return `now at ${this.driver.path()}, ${vp.width}x${vp.height}`;
  }

  async close() {
    this.coverage.flush();
    writeFileSync(join(this.opts.runDir, 'sessions', `${this.opts.session}.trace.json`), JSON.stringify(this.trace, null, 1));
    await this.driver.close();
  }
}

export function compressRanges(ns: number[]): string {
  const s = [...new Set(ns)].sort((a, b) => a - b);
  return s.length > 3 ? `${s[0]}–${s[s.length - 1]} (${s.length} widths)` : s.join(', ');
}

export { STRESS_KINDS };
