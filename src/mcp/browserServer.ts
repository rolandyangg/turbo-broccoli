/**
 * stdio MCP server that gives an explorer agent a guarded, fully-traced browser.
 * Launched by `claude -p --mcp-config` with configuration passed through BUGBASH_* env vars.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { BrowserSession, STRESS_KINDS } from './session.js';
import { Config } from '../config.js';
import { FindingType, Severity, BrowserName } from '../store/schema.js';
import { STRATEGY_IDS, strategiesOfCall } from '../explore/strategies.js';
import { DEVICE_PROFILES, describeDevices, deviceById } from '../explore/devices.js';
import { EVERYDAY_TOOLS } from '../explore/personas.js';

const env = (k: string, d?: string) => process.env[k] ?? d;
const config = Config.parse(JSON.parse(readFileSync(env('BUGBASH_CONFIG')!, 'utf8')));
const maxCalls = Number(env('BUGBASH_MAX_CALLS', String(config.maxToolCallsPerSession)));

const session = new BrowserSession({
  runDir: env('BUGBASH_RUN_DIR')!,
  session: env('BUGBASH_SESSION', 's-000')!,
  baseUrl: env('BUGBASH_BASE_URL')!,
  browser: BrowserName.parse(env('BUGBASH_BROWSER', 'chromium')),
  persona: env('BUGBASH_PERSONA') || null,
  config,
  startPath: env('BUGBASH_START_PATH', '/'),
  viewport: env('BUGBASH_VIEWPORT') ? JSON.parse(env('BUGBASH_VIEWPORT')!) : undefined,
  device: env('BUGBASH_DEVICE') || null,
});
/** Persona tool set, enforced here: "everyday" explorers cannot rewrite text, stress inputs or change the environment. */
const toolset = env('BUGBASH_TOOLSET', 'full');
const allowed = (name: string) => toolset !== 'everyday' || EVERYDAY_TOOLS.includes(name);
/** Run-level selections (strict): strategies turned off, and the allowed device profiles. */
const excludedStrategies = new Set((env('BUGBASH_EXCLUDE_STRATEGIES') ?? '').split(',').filter(Boolean));
const allowedDevices = (env('BUGBASH_ALLOWED_DEVICES') ?? '').split(',').filter(Boolean);
function runSelectionBlock(name: string, args: Record<string, unknown>): string | null {
  const hit = strategiesOfCall(name, args, (id) => deviceById(id)?.kind ?? null).filter((s) => excludedStrategies.has(s));
  if (hit.length) return `"${name}" exercises ${hit.join(', ')}, which is turned off for this run. Use a different approach.`;
  if (name === 'set_device' && allowedDevices.length && args.device && args.device !== 'none' && !allowedDevices.includes(deviceById(String(args.device))?.id ?? '')) return `Device "${args.device}" isn't selected for this run. Allowed: ${allowedDevices.join(', ')}.`;
  return null;
}

let calls = 0;
/** Process rule: after this many probe calls (tools that exercise a strategy) the explorer must log_hypothesis. */
const PROBES_PER_HYPOTHESIS = 8;
let probesSinceHypothesis = 0;
const isProbe = (name: string, args: Record<string, unknown>) => strategiesOfCall(name, args, (id) => deviceById(id)?.kind ?? null).length > 0;
const WRAP_UP_TOOLS = new Set(['record_finding', 'log_hypothesis', 'notes']);

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

// Tool calls share one page: run them strictly one at a time (agents may issue parallel calls).
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

function wrap<A>(name: string, fn: (args: A) => Promise<string | ToolResult> | string | ToolResult) {
  return (args: A): Promise<ToolResult> => serial(() => timed(name, fn, args));
}

/** Runs a tool and records its duration and outcome in the session log (agent observability). */
async function timed<A>(name: string, fn: (args: A) => Promise<string | ToolResult> | string | ToolResult, args: A): Promise<ToolResult> {
  const t0 = Date.now();
  const res = await run(name, fn, args);
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  const blocked = /is not available to your persona/.test(text) ? 'persona' : /is turned off for this run|isn't selected for this run/.test(text) ? 'selection' : /^Log a hypothesis first/.test(text) ? 'process' : /^BLOCKED by guardrails/.test(text) ? 'guardrail' : /BUDGET EXHAUSTED|Session over/.test(text) ? 'budget' : undefined;
  try {
    session.logTool({ name, ms: Date.now() - t0, ok: !res.isError && !blocked, ...(res.isError && !blocked ? { error: text.slice(0, 160) } : {}), ...(blocked ? { blocked } : {}) });
  } catch {}
  return res;
}

async function run<A>(name: string, fn: (args: A) => Promise<string | ToolResult> | string | ToolResult, args: A): Promise<ToolResult> {
  if (!allowed(name)) return { content: [{ type: 'text', text: `"${name}" is not available to your persona (normal mouse + keyboard use only). Use the normal interaction tools.` }], isError: true };
  const blockedBySelection = runSelectionBlock(name, (args ?? {}) as Record<string, unknown>);
  if (blockedBySelection) return { content: [{ type: 'text', text: blockedBySelection }], isError: true };
  const probe = isProbe(name, (args ?? {}) as Record<string, unknown>);
  if (probe && probesSinceHypothesis >= PROBES_PER_HYPOTHESIS)
    return { content: [{ type: 'text', text: `Log a hypothesis first: you've run ${probesSinceHypothesis} probes since the last log_hypothesis. Call log_hypothesis with what you were testing, the strategy id and the outcome (confirmed / refuted / inconclusive), then continue.` }], isError: true };
  {
    calls++;
    const over = calls - maxCalls;
    if (over > 0 && !WRAP_UP_TOOLS.has(name)) {
      return { content: [{ type: 'text', text: `BUDGET EXHAUSTED (${maxCalls} tool calls). Only record_finding, log_hypothesis and notes still work. Record anything outstanding, write a short note of what you learned, then stop.` }], isError: true };
    }
    if (over > 25) return { content: [{ type: 'text', text: 'Session over. Stop now.' }], isError: true };
    try {
      await session.start();
      const r = await fn(args);
      if (probe) probesSinceHypothesis++;
      if (name === 'log_hypothesis' || name === 'record_finding') probesSinceHypothesis = 0;
      const res: ToolResult = typeof r === 'string' ? { content: [{ type: 'text', text: r }] } : r;
      if (maxCalls - calls === 10) res.content.push({ type: 'text', text: '⏳ 10 tool calls left in your budget — start wrapping up.' });
      return res;
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      if (/closed|crash|disconnected|Target page/i.test(msg)) {
        const where = await session.recover().catch((err) => `recovery failed: ${(err as Error).message.split('\n')[0]}`);
        return { content: [{ type: 'text', text: `Error: ${msg}\nThe browser crashed and was restarted (${where}). Page state (open menus, typed text) was reset; redo the steps you need.` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  }
}

const server = new McpServer({ name: 'bugbash', version: '0.1.0' });
const ref = z.string().describe('Element ref from observe() (e.g. "e12") or a CSS selector');

server.registerTool(
  'observe',
  {
    description: 'Look at the current page: URL, viewport, variant, NEW/seen state, console errors, guardrail events, interactive elements with refs, accessibility tree, and a screenshot. Call after actions to see what changed.',
    inputSchema: { screenshot: z.boolean().optional().describe('Include a screenshot (default true)') },
  },
  wrap('observe', async ({ screenshot }: { screenshot?: boolean }) => {
    const o = await session.observe({ screenshot });
    const content: Content[] = [{ type: 'text', text: o.text }];
    if (o.screenshot) {
      content.push({ type: 'image', data: o.screenshot.base64, mimeType: o.screenshot.mime });
      content.push({ type: 'text', text: `(screenshot saved: ${o.screenshot.path})` });
    }
    return { content };
  }),
);

server.registerTool('screenshot', { description: 'Screenshot the viewport (or full page).', inputSchema: { full_page: z.boolean().optional() } }, wrap('screenshot', async ({ full_page }: { full_page?: boolean }) => {
  const s = await session.screenshot({ fullPage: full_page });
  return { content: [{ type: 'image', data: s.base64, mimeType: s.mime }, { type: 'text', text: `saved: ${s.path}` }] };
}));

server.registerTool('goto', { description: 'Navigate to a path on the site (same origin only), e.g. "/pricing".', inputSchema: { path: z.string() } }, wrap('goto', ({ path }: { path: string }) => session.goto(path)));
server.registerTool('back', { description: 'Browser back.', inputSchema: {} }, wrap('back', () => session.back()));
server.registerTool('forward', { description: 'Browser forward.', inputSchema: {} }, wrap('forward', () => session.forward()));
server.registerTool('reload', { description: 'Reload the page (e.g. mid-form).', inputSchema: {} }, wrap('reload', () => session.reload()));
server.registerTool('click', { description: 'Click an element. Destructive/off-site targets are blocked by guardrails.', inputSchema: { ref } }, wrap('click', ({ ref }: { ref: string }) => session.click(ref)));
server.registerTool('rapid_click', { description: 'Click an element n times as fast as possible (double/triple-click chaos).', inputSchema: { ref, n: z.number().int().min(2).max(20).default(3) } }, wrap('rapid_click', ({ ref, n }: { ref: string; n: number }) => session.click(ref, n)));
server.registerTool('hover', { description: 'Hover an element (menus, tooltips, transitions).', inputSchema: { ref } }, wrap('hover', ({ ref }: { ref: string }) => session.hover(ref)));
server.registerTool('type', { description: 'Fill an input with exact text.', inputSchema: { ref, text: z.string() } }, wrap('type', ({ ref, text }: { ref: string; text: string }) => session.type(ref, text)));
server.registerTool(
  'stress_fill',
  { description: `Fill an input with generated data. kinds: ${STRESS_KINDS.join(', ')}.`, inputSchema: { ref, kind: z.enum(STRESS_KINDS) } },
  wrap('stress_fill', ({ ref, kind }: { ref: string; kind: (typeof STRESS_KINDS)[number] }) => session.stressFill(ref, kind)),
);
server.registerTool('select', { description: 'Choose an option in a <select>.', inputSchema: { ref, value: z.string() } }, wrap('select', ({ ref, value }: { ref: string; value: string }) => session.select(ref, value)));
server.registerTool(
  'check_focus',
  {
    description: 'Walk the keyboard tab order: presses Tab (or Shift+Tab with reverse) up to `steps` times and checks every stop for an invisible focus indicator, focus hidden under a sticky/fixed bar, and focus escaping an open dialog. Returns the focus order and candidates for record_finding.',
    inputSchema: { steps: z.number().int().min(1).max(40).optional().describe('Tab presses (default 15)'), reverse: z.boolean().optional() },
  },
  wrap('check_focus', ({ steps, reverse }: { steps?: number; reverse?: boolean }) => session.checkFocus({ steps, reverse })),
);
server.registerTool('press', { description: 'Press a key (Tab, Shift+Tab, Enter, Escape, ArrowDown...). Returns the focused element.', inputSchema: { key: z.string() } }, wrap('press', ({ key }: { key: string }) => session.press(key)));
server.registerTool(
  'scroll',
  { description: 'Scroll to top/bottom/left/right or exact coordinates.', inputSchema: { to: z.enum(['top', 'bottom', 'left', 'right']).optional(), x: z.number().optional(), y: z.number().optional() } },
  wrap('scroll', ({ to, x, y }: { to?: 'top' | 'bottom' | 'left' | 'right'; x?: number; y?: number }) => session.scroll(to ?? { x: x ?? 0, y: y ?? 0 })),
);
server.registerTool('resize', { description: 'Set the viewport size.', inputSchema: { width: z.number().int().min(200).max(3840), height: z.number().int().min(200).max(2400).optional() } }, wrap('resize', ({ width, height }: { width: number; height?: number }) => session.resize(width, height)));
server.registerTool(
  'set_variant',
  {
    description: 'Change the environment: color scheme, font scale (2 = 200% text), zoom (0.5–3), device pixel ratio, reduced motion, network (online/offline/slow-3g), blocked resource types (font, image, stylesheet, media).',
    inputSchema: {
      colorScheme: z.enum(['light', 'dark']).optional(),
      fontScale: z.number().min(0.5).max(3).optional(),
      zoom: z.number().min(0.25).max(4).optional(),
      dpr: z.number().min(1).max(3).optional(),
      reducedMotion: z.boolean().optional(),
      network: z.enum(['online', 'offline', 'slow-3g']).optional(),
      blocked: z.array(z.enum(['font', 'image', 'stylesheet', 'media'])).optional(),
    },
  },
  wrap('set_variant', (v: Record<string, unknown>) => session.setVariant(v)),
);
server.registerTool(
  'set_device',
  {
    description: `Emulate a real device (touch, no hover, mobile UA, DPR, meta viewport) or a common desktop size. resize() is only a narrow DESKTOP window; use this for phone/tablet claims. "none" returns to a desktop window. Devices: ${describeDevices()}.`,
    inputSchema: { device: z.enum(['none', ...DEVICE_PROFILES.map((d) => d.id)] as [string, ...string[]]) },
  },
  wrap('set_device', ({ device }: { device: string }) => session.setDevice(device)),
);
server.registerTool(
  'sweep_devices',
  { description: 'Render the current page state on several real device profiles (default: all phones and tablets) and run the detectors on each. Your own page is not changed.', inputSchema: { devices: z.array(z.string()).optional(), min_confidence: z.number().optional() } },
  wrap('sweep_devices', ({ devices, min_confidence }: { devices?: string[]; min_confidence?: number }) => {
    // Only the run's selected devices (phones/tablets by default).
    const pool = (devices?.length ? devices : DEVICE_PROFILES.filter((d) => d.kind !== 'desktop').map((d) => d.id)).filter((d) => !allowedDevices.length || allowedDevices.includes(deviceById(d)?.id ?? ''));
    if (!pool.length) return 'None of those devices are selected for this run.';
    return session.sweepDevices({ devices: pool, minConfidence: min_confidence });
  }),
);
server.registerTool(
  'mutate_text',
  { description: 'Replace an element\'s visible text with longer text (translation stress). Give factor (e.g. 2.5), locale ("de"/"fi" for long compound words) or exact text.', inputSchema: { ref, factor: z.number().min(1).max(10).optional(), locale: z.enum(['de', 'fi']).optional(), text: z.string().optional() } },
  wrap('mutate_text', ({ ref, ...o }: { ref: string; factor?: number; locale?: string; text?: string }) => session.mutateText(ref, o)),
);
server.registerTool(
  'run_detectors',
  { description: 'Run deterministic layout detectors (text overflow, spill-out, overlap, spacing, viewport overflow, tap targets, broken images, layout shift) on the current state. Returns candidate ids. Candidates are hints: confirm visually.', inputSchema: { only: z.array(z.string()).optional(), scope: z.string().optional().describe('CSS selector to limit detection'), min_confidence: z.number().optional() } },
  wrap('run_detectors', ({ only, scope, min_confidence }: { only?: string[]; scope?: string; min_confidence?: number }) => session.runDetectors({ only, scope, minConfidence: min_confidence })),
);
server.registerTool(
  'sweep_viewports',
  { description: 'Resize a DESKTOP window through many widths, run detectors at each, and restore the viewport. Not a phone (no touch, no mobile UA): use sweep_devices for phones/tablets.', inputSchema: { widths: z.array(z.number().int()).optional(), height: z.number().int().optional(), min_confidence: z.number().optional() } },
  wrap('sweep_viewports', ({ widths, height, min_confidence }: { widths?: number[]; height?: number; min_confidence?: number }) => session.sweepViewports({ widths, height, minConfidence: min_confidence })),
);
server.registerTool('find_similar', { description: 'Find other instances of the same component (same DOM structure signature) on this page — use to hunt sibling bugs.', inputSchema: { ref } }, wrap('find_similar', ({ ref }: { ref: string }) => session.findSimilar(ref)));
server.registerTool(
  'record_finding',
  {
    description: 'Record a confirmed UI defect. Attaches trace, viewport, element box and an annotated screenshot automatically. Prefer passing candidate_id when a detector found it; otherwise pass ref for the affected element.',
    inputSchema: {
      type: FindingType,
      title: z.string().describe('Short, specific: what is wrong with which element'),
      description: z.string().describe('What you see, expected vs actual, and conditions (widths, input, sequence)'),
      severity: Severity,
      confidence: z.number().min(0).max(1).describe('How sure you are this is a real, user-visible defect'),
      candidate_id: z.string().optional(),
      ref: z.string().optional(),
      hypothesis: z.string().min(8).describe('Required: what you suspected would break and why (e.g. "the price row has no wrap, so long German labels will clip at phone widths")'),
      strategy: z.enum(STRATEGY_IDS as [string, ...string[]]).describe('Required: the strategy id that found it'),
      category: z.enum(['layout', 'ux-functional']).optional().describe('layout (default) for visual/UI defects; ux-functional for behaviour bugs: broken flows, wrong results, errors'),
      seeded_by_code_intel: z.boolean().optional(),
      temporal: z.boolean().optional().describe('True if the defect is time-based (flicker, shift, transition)'),
    },
  },
  wrap('record_finding', (a: Parameters<BrowserSession['recordFinding']>[0]) => session.recordFinding(a)),
);
server.registerTool(
  'log_hypothesis',
  { description: 'Log a hypothesis you tested and its outcome (also for refuted ones).', inputSchema: { hypothesis: z.string().min(8), strategy: z.enum(STRATEGY_IDS as [string, ...string[]]).describe('Strategy id this probe batch exercised'), outcome: z.enum(['confirmed', 'refuted', 'inconclusive']), note: z.string().optional() } },
  wrap('log_hypothesis', (a: Parameters<BrowserSession['logHypothesis']>[0]) => session.logHypothesis(a)),
);
server.registerTool('coverage', { description: 'Coverage across all explorer sessions in this run: states, untried elements, untested widths/browsers/strategies per page.', inputSchema: { page: z.string().optional() } }, wrap('coverage', ({ page }: { page?: string }) => session.coverageReport(page)));
server.registerTool('strategy_coverage', { description: 'Checklist of attack strategies tried/untried on the current page (across all sessions).', inputSchema: {} }, wrap('strategy_coverage', () => session.strategyCoverage()));
server.registerTool('notes', { description: 'Shared scratchpad across sessions. action=read or write.', inputSchema: { action: z.enum(['read', 'write']), text: z.string().optional() } }, wrap('notes', ({ action, text }: { action: 'read' | 'write'; text?: string }) => session.notes(action, text)));

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  await session.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('close', shutdown);
