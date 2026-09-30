import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import getPort from 'get-port';
import { runClaude, tsxServer, type ClaudeRunResult } from '../llm/claude.js';
import type { Config } from '../config.js';
import type { BrowserName, RawFinding } from '../store/schema.js';
import { mergeAll, summarize, pageKey } from './coverage.js';
import { summarizeIntel, type CodeIntel } from './codeIntel.js';
import { Memory } from '../memory/siteMemory.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');
export const PERSONAS_DIR = join(here, 'prompts', 'personas');
export const PERSONAS = ['phone-user', 'keyboard-user', 'german-user', 'impatient-user', 'power-user', 'low-vision-user'];

export interface CampaignOptions {
  runId: string;
  runDir: string;
  workspace: string;
  baseUrl: string;
  config: Config;
  intel: CodeIntel | null;
  log: (msg: string) => void;
  /** Skip the lead agent and run a fixed default plan (for debugging / cheap runs). */
  noLead?: boolean;
}

export interface ExplorerJob {
  id: string;
  goal: string;
  persona: string | null;
  browser: BrowserName;
  pages: string[];
  viewport: { width: number; height: number } | null;
  hypotheses: string[];
  maxToolCalls: number;
  kind: 'explore' | 'sibling-hunt' | 'fallback';
  status: 'queued' | 'running' | 'done' | 'failed';
  startedAt?: number;
  endedAt?: number;
  result?: Pick<ClaudeRunResult, 'ok' | 'toolCalls' | 'durationMs' | 'error'> & { summary: string };
  newFindings?: number;
  totalFindings?: number;
}

export interface CampaignResult {
  jobs: ExplorerJob[];
  stopReason: string;
  leadDecisions: string[];
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

const quickFp = (f: RawFinding) => `${f.type}|${f.element.selector ?? f.title}|${f.page}`;

export class Campaign {
  jobs: ExplorerJob[] = [];
  decisions: string[] = [];
  stopReason: string | null = null;
  private seenFps = new Set<string>();
  private running = 0;
  private waiters: (() => void)[] = [];
  private startedAt = Date.now();
  private counter = 0;
  private memory: Memory;
  private server?: Server;
  private token = randomBytes(12).toString('hex');

  constructor(private o: CampaignOptions) {
    this.memory = new Memory(o.workspace);
    mkdirSync(join(o.runDir, 'transcripts'), { recursive: true });
    writeFileSync(join(o.runDir, 'config.json'), JSON.stringify(o.config));
  }

  private get cfg() {
    return this.o.config;
  }

  private budgetLeft() {
    const spawned = this.jobs.length;
    const timeLeft = this.cfg.timeLimitMs - (Date.now() - this.startedAt);
    return { sessions: this.cfg.budgetSessions - spawned, timeMs: timeLeft };
  }

  // ---------------- explorer execution ----------------

  spawn(spec: Partial<ExplorerJob> & { goal: string }): ExplorerJob | string {
    const left = this.budgetLeft();
    if (this.stopReason) return `Campaign stopped: ${this.stopReason}`;
    if (left.sessions <= 0) return 'Session budget exhausted. Call stop() with your summary.';
    if (left.timeMs <= 60_000) return 'Time budget exhausted. Call stop() with your summary.';
    const dup = this.jobs.find((j) => j.goal.trim().toLowerCase() === spec.goal.trim().toLowerCase() && j.browser === (spec.browser ?? 'chromium') && j.persona === (spec.persona ?? null));
    if (dup) return `Duplicate of ${dup.id}; not spawned.`;
    const persona = spec.persona && PERSONAS.includes(spec.persona) ? spec.persona : null;
    const job: ExplorerJob = {
      id: `s-${String(++this.counter).padStart(3, '0')}`,
      goal: spec.goal,
      persona,
      browser: spec.browser && this.cfg.browsers.includes(spec.browser) ? spec.browser : 'chromium',
      pages: spec.pages?.length ? spec.pages : [this.cfg.startPaths[0]],
      viewport: spec.viewport ?? null,
      hypotheses: spec.hypotheses ?? [],
      maxToolCalls: Math.min(spec.maxToolCalls ?? this.cfg.maxToolCallsPerSession, this.cfg.maxToolCallsPerSession * 2),
      kind: spec.kind ?? 'explore',
      status: 'queued',
    };
    this.jobs.push(job);
    this.o.log(`▶ ${job.id} [${job.browser}${job.persona ? '/' + job.persona : ''}] ${job.goal.slice(0, 100)}`);
    this.pump();
    return job;
  }

  private pump() {
    while (this.running < this.cfg.parallel) {
      const next = this.jobs.find((j) => j.status === 'queued');
      if (!next) return;
      this.running++;
      next.status = 'running';
      next.startedAt = Date.now();
      this.runExplorer(next)
        .catch((e) => {
          next.status = 'failed';
          next.result = { ok: false, toolCalls: 0, durationMs: 0, error: String(e), summary: '' };
        })
        .finally(() => {
          this.running--;
          next.endedAt = Date.now();
          this.accountFindings(next);
          this.o.log(`■ ${next.id} ${next.status} — ${next.newFindings ?? 0} new / ${next.totalFindings ?? 0} findings, ${next.result?.toolCalls ?? 0} tool calls, ${Math.round((next.result?.durationMs ?? 0) / 1000)}s`);
          this.waiters.splice(0).forEach((w) => w());
          this.pump();
        });
    }
  }

  private accountFindings(job: ExplorerJob) {
    const mine = readJsonl<RawFinding>(join(this.o.runDir, 'agent-findings.jsonl')).filter((f) => f.session === job.id);
    let fresh = 0;
    for (const f of mine) {
      const fp = quickFp(f);
      if (!this.seenFps.has(fp)) {
        this.seenFps.add(fp);
        fresh++;
      }
    }
    job.totalFindings = mine.length;
    job.newFindings = fresh;
  }

  private explorerPrompt(job: ExplorerJob): string {
    const persona = job.persona ? readFileSync(join(PERSONAS_DIR, `${job.persona}.md`), 'utf8') : 'Persona: general QA tester across all device sizes.';
    const notesFile = join(this.o.runDir, 'notes.md');
    const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8').slice(-2500) : '';
    const cov = summarize(mergeAll(this.o.runDir), this.cfg.viewports.widths, this.cfg.browsers).filter((c) => job.pages.map(pageKey).includes(c.page));
    return [
      `# Your assignment (${job.id})`,
      `Goal: ${job.goal}`,
      `Browser: ${job.browser}. Start page: ${job.pages[0]}${job.pages.length > 1 ? `. Also cover: ${job.pages.slice(1).join(', ')}` : ''}.`,
      persona,
      job.hypotheses.length ? `\nHypotheses to test first (from the lead / code analysis):\n${job.hypotheses.map((h) => `- ${h}`).join('\n')}` : '',
      cov.length ? `\nCoverage so far on your pages (from other explorers):\n${JSON.stringify(cov.map((c) => ({ page: c.page, widths_untested: c.widths_untested, strategies_untried: c.strategies_untried.slice(0, 12), untried_examples: c.untried_examples.slice(0, 6) })))}` : '',
      notes ? `\nShared notes from other explorers:\n${notes}` : '',
      `\nYou have about ${job.maxToolCalls} tool calls. Start with observe().`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async runExplorer(job: ExplorerJob) {
    const env: Record<string, string> = {
      BUGBASH_CONFIG: join(this.o.runDir, 'config.json'),
      BUGBASH_RUN_DIR: this.o.runDir,
      BUGBASH_BASE_URL: this.o.baseUrl,
      BUGBASH_SESSION: job.id,
      BUGBASH_BROWSER: job.browser,
      BUGBASH_PERSONA: job.persona ?? '',
      BUGBASH_START_PATH: job.pages[0],
      BUGBASH_MAX_CALLS: String(job.maxToolCalls),
    };
    if (job.viewport) env.BUGBASH_VIEWPORT = JSON.stringify(job.viewport);
    else if (job.persona === 'phone-user') env.BUGBASH_VIEWPORT = JSON.stringify({ width: 375, height: 740 });
    const r = await runClaude({
      prompt: this.explorerPrompt(job),
      systemPrompt: readFileSync(join(here, 'prompts', 'explorer.md'), 'utf8'),
      mcpServers: { bugbash: tsxServer(join(SRC, 'mcp', 'browserServer.ts'), env) },
      allowedTools: ['mcp__bugbash'],
      model: this.cfg.model,
      timeoutMs: this.cfg.sessionTimeoutMs,
      transcriptPath: join(this.o.runDir, 'transcripts', `${job.id}.jsonl`),
    });
    job.status = r.ok ? 'done' : 'failed';
    job.result = { ok: r.ok, toolCalls: r.toolCalls, durationMs: r.durationMs, error: r.error, summary: r.text.slice(0, 1500) };
  }

  async awaitAny(timeoutMs = 25 * 60_000): Promise<void> {
    if (!this.jobs.some((j) => j.status === 'running' || j.status === 'queued')) return;
    await Promise.race([new Promise<void>((r) => this.waiters.push(r)), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  async awaitAll() {
    while (this.jobs.some((j) => j.status === 'running' || j.status === 'queued')) await this.awaitAny();
  }

  // ---------------- views for the lead ----------------

  findingsSummary() {
    const all = readJsonl<RawFinding>(join(this.o.runDir, 'agent-findings.jsonl'));
    const byPage: Record<string, number> = {};
    const bySig: Record<string, number> = {};
    for (const f of all) {
      byPage[f.page] = (byPage[f.page] ?? 0) + 1;
      if (f.element.signature) bySig[f.element.signature] = (bySig[f.element.signature] ?? 0) + 1;
    }
    const finished = this.jobs.filter((j) => j.status === 'done' || j.status === 'failed');
    const window = finished.slice(-this.cfg.saturationWindow);
    const recentNew = window.reduce((a, j) => a + (j.newFindings ?? 0), 0);
    const saturated = window.length >= this.cfg.saturationWindow && recentNew < this.cfg.saturationMinNew;
    const left = this.budgetLeft();
    return {
      total_findings: all.length,
      unique_findings: this.seenFps.size,
      by_page: byPage,
      hot_components: Object.entries(bySig).sort((a, b) => b[1] - a[1]).slice(0, 10),
      sessions: this.jobs.map((j) => ({ id: j.id, status: j.status, browser: j.browser, persona: j.persona, goal: j.goal.slice(0, 120), new: j.newFindings ?? null, total: j.totalFindings ?? null, summary: j.result?.summary?.slice(0, 400) ?? null })),
      saturation: { window: window.length, new_in_window: recentNew, saturated },
      budget: { sessions_left: left.sessions, minutes_left: Math.round(left.timeMs / 60000), running: this.running },
      findings: all.map((f, i) => ({ index: i, session: f.session, browser: f.environment.browser, page: f.page, type: f.type, title: f.title, confidence: f.confidence, signature: f.element.signature, viewport: `${f.environment.viewport.width}x${f.environment.viewport.height}`, strategy: f.strategy })).slice(-80),
    };
  }

  siteMap() {
    const cov = mergeAll(this.o.runDir);
    const pages = new Set<string>([...Object.keys(cov), ...(this.o.intel?.routes ?? []), ...this.memory.site().routes, ...this.cfg.startPaths.map(pageKey)]);
    const links = new Set<string>();
    for (const pc of Object.values(cov)) for (const [sel, text] of Object.entries(pc.seen)) if (/href|^a|> a/.test(sel)) links.add(`${text} (${sel})`);
    return { pages: [...pages].sort(), visited: Object.keys(cov), link_examples: [...links].slice(0, 40) };
  }

  huntSiblings(index: number) {
    const all = readJsonl<RawFinding>(join(this.o.runDir, 'agent-findings.jsonl'));
    const f = all[index];
    if (!f) return `No finding at index ${index}.`;
    const comp = this.o.intel?.components.find((c) => f.element.selector && f.element.signature && f.element.signature.toLowerCase().includes(c.name.toLowerCase()));
    const pagesWithSig = Object.entries(mergeAll(this.o.runDir))
      .filter(([, pc]) => Object.keys(pc.seen).some((s) => f.element.selector && s.split(' > ').pop() === f.element.selector.split(' > ').pop()))
      .map(([p]) => p);
    const pages = [...new Set([f.page, ...pagesWithSig, ...this.o.intel?.routes.slice(0, 6) ?? []])];
    return this.spawn({
      goal: `Sibling hunt for "${f.title}" (${f.type}). The defect is in element ${f.element.selector} with component signature "${f.element.signature}". It was triggered by strategy ${f.strategy ?? 'unknown'} at ${f.environment.viewport.width}x${f.environment.viewport.height} (${f.environment.browser}). Find EVERY other instance of this component (use find_similar on each page) and apply the same trigger to each; record each distinct broken instance.${comp ? ` Source component ${comp.name} is used in: ${comp.usedIn.join(', ')}.` : ''}`,
      pages,
      browser: f.environment.browser,
      viewport: f.environment.viewport,
      persona: f.persona,
      kind: 'sibling-hunt',
      maxToolCalls: Math.round(this.cfg.maxToolCallsPerSession * 0.6),
    });
  }

  // ---------------- control API for the lead MCP server ----------------

  private async startControlServer(): Promise<string> {
    const port = await getPort();
    this.server = createServer(async (req, res) => {
      if (req.headers['x-bugbash-token'] !== this.token) return res.writeHead(403).end();
      let body = '';
      for await (const c of req) body += c;
      const args = body ? JSON.parse(body) : {};
      let out: unknown;
      try {
        switch (req.url) {
          case '/spawn': {
            const j = this.spawn(args);
            out = typeof j === 'string' ? { error: j } : { id: j.id, status: j.status };
            if (typeof j !== 'string') this.decisions.push(`spawn ${j.id}: ${j.goal.slice(0, 160)}`);
            break;
          }
          case '/await':
            await this.awaitAny(Math.min(args.timeout_ms ?? 20 * 60_000, 25 * 60_000));
            out = this.findingsSummary();
            break;
          case '/findings':
            out = this.findingsSummary();
            break;
          case '/coverage':
            out = summarize(mergeAll(this.o.runDir), this.cfg.viewports.widths, this.cfg.browsers);
            break;
          case '/site_map':
            out = this.siteMap();
            break;
          case '/code_intel':
            out = { text: summarizeIntel(this.o.intel) };
            break;
          case '/memory':
            if (args.action === 'write' && args.text) {
              this.memory.appendLessons(this.o.runId, args.text);
              out = { ok: true };
            } else out = { text: this.memory.summary() };
            break;
          case '/hunt': {
            const j = this.huntSiblings(args.finding_index);
            out = typeof j === 'string' ? { error: j } : { id: j.id };
            if (typeof j !== 'string') this.decisions.push(`hunt_siblings(${args.finding_index}) → ${j.id}`);
            break;
          }
          case '/note':
            this.decisions.push(String(args.text).slice(0, 400));
            out = { ok: true };
            break;
          case '/stop':
            this.stopReason = String(args.reason ?? 'lead stopped');
            this.decisions.push(`STOP: ${this.stopReason}`);
            out = { ok: true, message: 'Stopping. Running explorers will finish; no new ones will start.' };
            break;
          default:
            res.writeHead(404).end();
            return;
        }
      } catch (e) {
        out = { error: String(e) };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
    await new Promise<void>((r) => this.server!.listen(port, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${port}`;
  }

  // ---------------- entry point ----------------

  async run(): Promise<CampaignResult> {
    if (this.o.noLead) {
      this.defaultPlan();
      await this.awaitAll();
      return { jobs: this.jobs, stopReason: 'fixed plan completed (--no-lead)', leadDecisions: [] };
    }
    const control = await this.startControlServer();
    const leadPrompt = [
      `Target: ${this.o.baseUrl}. Start paths: ${this.cfg.startPaths.join(', ')}.`,
      `Browsers available: ${this.cfg.browsers.join(', ')}. Personas: ${PERSONAS.join(', ')}.`,
      `Budget: ${this.cfg.budgetSessions} explorer sessions, ${Math.round(this.cfg.timeLimitMs / 60000)} minutes, ${this.cfg.parallel} in parallel, ~${this.cfg.maxToolCallsPerSession} tool calls each.`,
      `Stop rule: saturation when the last ${this.cfg.saturationWindow} sessions produce fewer than ${this.cfg.saturationMinNew} new unique findings in total (findings_summary.saturation.saturated), or when budget runs out.`,
      `Begin by reading memory, code_intel and site_map, then plan and spawn the first wave.`,
    ].join('\n');
    const lead = runClaude({
      prompt: leadPrompt,
      systemPrompt: readFileSync(join(here, 'prompts', 'lead.md'), 'utf8'),
      mcpServers: { lead: tsxServer(join(SRC, 'mcp', 'leadServer.ts'), { BUGBASH_CONTROL: control, BUGBASH_TOKEN: this.token }) },
      allowedTools: ['mcp__lead', ...(this.o.intel ? ['Read', 'Grep', 'Glob'] : [])],
      tools: this.o.intel ? ['Read', 'Grep', 'Glob'] : [],
      addDirs: this.o.intel ? [this.o.intel.repo] : [],
      cwd: this.o.intel?.repo,
      model: this.cfg.model,
      timeoutMs: this.cfg.timeLimitMs + 10 * 60_000,
      transcriptPath: join(this.o.runDir, 'transcripts', 'lead.jsonl'),
    });
    const leadResult = await lead;
    if (!leadResult.ok) this.o.log(`Lead agent ended with error: ${leadResult.error}`);
    if (!this.stopReason) this.stopReason = leadResult.ok ? 'lead finished without calling stop()' : `lead error: ${leadResult.error}`;
    // Safety net: if the lead died before doing anything useful, fall back to a fixed plan.
    if (this.jobs.length === 0) {
      this.o.log('Lead spawned no explorers; running fallback plan.');
      this.stopReason += ' (fallback plan used)';
      this.defaultPlan();
    }
    await this.awaitAll();
    this.server?.close();
    this.server?.closeAllConnections();
    if (leadResult.text) this.decisions.push(`Lead final message: ${leadResult.text.slice(0, 1500)}`);
    return { jobs: this.jobs, stopReason: this.stopReason, leadDecisions: this.decisions };
  }

  private defaultPlan() {
    const seeds = this.o.intel?.hypotheses.slice(0, 8).map((h) => h.text) ?? [];
    const pages = this.o.intel?.routes.length ? this.o.intel.routes.filter((r) => !r.includes(':')) : this.cfg.startPaths;
    const personas = ['phone-user', 'german-user', 'impatient-user', 'keyboard-user', 'low-vision-user', 'power-user'];
    let i = 0;
    for (const p of pages) {
      const persona = personas[i++ % personas.length];
      this.spawn({ goal: `Explore ${p} and every flow reachable from it; break the layout.`, pages: [p], persona, hypotheses: seeds, kind: 'fallback' });
    }
    for (const b of this.cfg.browsers.filter((b) => b !== 'chromium')) this.spawn({ goal: `Cross-browser check of the riskiest pages in ${b}.`, pages, browser: b, hypotheses: seeds, kind: 'fallback' });
  }
}
