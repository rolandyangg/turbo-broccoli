import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserName } from './store/schema.js';

export const DEFAULT_DENYLIST =
  'delete|remove|destroy|log ?out|sign ?out|pay\\b|payment|purchase|checkout|buy now|place order|unsubscribe|deactivate|reset|close account|cancel subscription';

export const Config = z.object({
  /** Paths to start exploring from (relative to baseUrl). */
  startPaths: z.array(z.string()).default(['/']),
  browsers: z.array(BrowserName).default(['chromium', 'webkit', 'firefox']),
  personas: z.array(z.string()).default([]), // empty = all built-in personas
  /** Personas the lead must not use. low-vision-user is off by default (re-enable by removing it). */
  disabledPersonas: z.array(z.string()).default(['low-vision-user']),
  /** Personas that get most of the session budget. */
  priorityPersonas: z.array(z.string()).default(['everyday-user', 'phone-user']),
  parallel: z.number().int().min(1).default(3),
  budgetSessions: z.number().int().min(1).default(12),
  /** Max tool calls one explorer session may make before being told to wrap up. */
  maxToolCallsPerSession: z.number().int().default(120),
  sessionTimeoutMs: z.number().int().default(20 * 60_000),
  timeLimitMs: z.number().int().default(2 * 60 * 60_000),
  /** Stop when the last `saturationWindow` sessions found fewer than `saturationMinNew` new unique findings in total. */
  saturationWindow: z.number().int().default(4),
  saturationMinNew: z.number().int().default(1),
  guardrails: z
    .object({
      sameOriginOnly: z.boolean().default(true),
      extraAllowedOrigins: z.array(z.string()).default([]),
      denylist: z.string().default(DEFAULT_DENYLIST),
      allowMutations: z.boolean().default(false),
    })
    .default(() => ({ sameOriginOnly: true, extraAllowedOrigins: [], denylist: DEFAULT_DENYLIST, allowMutations: false })),
  viewports: z
    .object({
      widths: z.array(z.number()).default([320, 360, 375, 390, 414, 600, 768, 820, 1024, 1280, 1440, 1920]),
      heights: z.array(z.number()).default([640, 900]),
    })
    .default(() => ({ widths: [320, 360, 375, 390, 414, 600, 768, 820, 1024, 1280, 1440, 1920], heights: [640, 900] })),
  detectors: z
    .object({
      minGapPx: z.number().default(4),
      minTapTargetPx: z.number().default(24),
      edgePaddingPx: z.number().default(2),
    })
    .default(() => ({ minGapPx: 4, minTapTargetPx: 24, edgePaddingPx: 2 })),
  confidenceThreshold: z.number().default(0.5),
  provider: z.enum(['claude', 'codex']).nullable().default(null), // null = machine default
  model: z.string().trim().min(1).max(200).nullable().default(null),
  /** Command to start the app for a local repo; auto-detected when null. */
  devCommand: z.string().nullable().default(null),
  devPort: z.number().nullable().default(null),
  /** Minimum explorer sessions per persona (strict: the campaign won't stop before these are met). */
  personaSessions: z.record(z.string(), z.number().int().min(0)).default({}),
  /** Allowed device profile ids (devices.ts); empty = all. */
  devices: z.array(z.string()).default([]),
  /** Attack strategies: include (empty = all) / exclude. Excluded strategies' tools are refused. */
  strategies: z
    .object({ include: z.array(z.string()).default([]), exclude: z.array(z.string()).default([]) })
    .default(() => ({ include: [], exclude: [] })),
  /** Pages the lead must cover (in addition to what it discovers). */
  focusPaths: z.array(z.string()).default([]),
  /** Use the lead agent (false = fixed plan built from personas × devices × pages). */
  lead: z.boolean().default(true),
  /** Read the source repo before exploring. */
  codeIntel: z.boolean().default(true),
  triage: z.object({ video: z.boolean().default(true), review: z.boolean().default(true) }).default(() => ({ video: true, review: true })),
  /** Run the retrospective agent after triage. */
  retrospective: z.boolean().default(true),
});
export type Config = z.infer<typeof Config>;

/** Layers: repo bugbash.config.json < preset < explicit overrides (CLI flags / launcher form). */
export function loadConfig(dir: string, overrides: Partial<Config> = {}, preset: Partial<Config> = {}): Config {
  const file = join(dir, 'bugbash.config.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return Config.parse({ ...fromFile, ...stripUndefined(preset), ...stripUndefined(overrides) });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Validates a partial config and returns ONLY the keys that were provided. (zod's .partial() still applies
 * defaults to missing keys, which would silently override presets.)
 */
export function pickConfig(input: Record<string, unknown>): { ok: true; config: Partial<Config> } | { ok: false; error: string } {
  const shape = Config.shape as Record<string, z.ZodTypeAny>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v === undefined) continue;
    if (!(k in shape)) return { ok: false, error: `Unknown setting "${k}"` };
    const r = shape[k].safeParse(v);
    if (!r.success) return { ok: false, error: `${k}${r.error.issues[0]?.path.length ? '.' + r.error.issues[0].path.join('.') : ''}: ${r.error.issues[0]?.message}` };
    out[k] = r.data;
  }
  return { ok: true, config: out as Partial<Config> };
}
