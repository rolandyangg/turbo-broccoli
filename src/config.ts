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
  model: z.string().nullable().default(null), // passed to `claude --model` when set
  /** Command to start the app for a local repo; auto-detected when null. */
  devCommand: z.string().nullable().default(null),
  devPort: z.number().nullable().default(null),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(dir: string, overrides: Partial<Config> = {}): Config {
  const file = join(dir, 'bugbash.config.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  return Config.parse({ ...fromFile, ...stripUndefined(overrides) });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
