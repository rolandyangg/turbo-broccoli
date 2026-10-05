import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sendMacNotification } from './macos.js';
import { z } from 'zod';

/**
 * Notifications for long-running work (runs, triage, fixes, failures, proposals) on three channels:
 * macOS notifications, the web app's inbox, and a Slack incoming webhook. Settings and the inbox live in
 * ~/.bugbash (BUGBASH_HOME overrides); the webhook URL is stored there only, never in a repo.
 */
export const NotifyEvent = z.enum(['run', 'fix', 'failure', 'proposals']);
export type NotifyEvent = z.infer<typeof NotifyEvent>;

export const Settings = z.object({
  channels: z
    .object({
      macos: z.boolean().default(true),
      inbox: z.boolean().default(true),
      slack: z.boolean().default(false),
    })
    .default(() => ({ macos: true, inbox: true, slack: false })),
  slack_webhook: z.string().nullable().default(null),
  events: z
    .object({ run: z.boolean().default(true), fix: z.boolean().default(true), failure: z.boolean().default(true), proposals: z.boolean().default(true) })
    .default(() => ({ run: true, fix: true, failure: true, proposals: true })),
  /** Base URL of the web app, used for links in notifications. */
  web_url: z.string().default('http://127.0.0.1:4317'),
});
export type Settings = z.infer<typeof Settings>;

export interface Notification {
  id: string;
  at: string;
  event: NotifyEvent;
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  body: string;
  /** Path in the web app, e.g. /runs/<ws>/<run>. */
  path: string | null;
  read: boolean;
}

export const home = () => process.env.BUGBASH_HOME || join(homedir(), '.bugbash');
const settingsFile = () => join(home(), 'settings.json');
const inboxFile = () => join(home(), 'notifications.jsonl');

export function readSettings(): Settings {
  try {
    return Settings.parse(existsSync(settingsFile()) ? JSON.parse(readFileSync(settingsFile(), 'utf8')) : {});
  } catch {
    return Settings.parse({});
  }
}
export function writeSettings(s: Settings) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(Settings.parse(s), null, 2) + '\n', { mode: 0o600 });
}

export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[\w/-]+$/;

/** Same id the web app uses for a workspace (sha1 of its path), for links. */
export const wsIdOf = (wsPath: string) => createHash('sha1').update(wsPath).digest('hex').slice(0, 10);
export const runPath = (wsPath: string, run: string) => `/runs/${wsIdOf(wsPath)}/${encodeURIComponent(run)}`;

export function readInbox(limit = 200): Notification[] {
  if (!existsSync(inboxFile())) return [];
  const out: Notification[] = [];
  for (const l of readFileSync(inboxFile(), 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out.slice(-limit).reverse();
}
export function markRead(ids: string[] | 'all') {
  if (!existsSync(inboxFile())) return 0;
  const all = readInbox(100000).reverse();
  let n = 0;
  for (const x of all)
    if (!x.read && (ids === 'all' || ids.includes(x.id))) {
      x.read = true;
      n++;
    }
  // Keep the inbox bounded.
  writeFileSync(inboxFile(), all.slice(-1000).map((x) => JSON.stringify(x)).join('\n') + '\n');
  return n;
}

export interface NotifyInput {
  event: NotifyEvent;
  level?: Notification['level'];
  title: string;
  body: string;
  path?: string | null;
}

/** Tests never notify unless they opt in (and then only to BUGBASH_HOME). */
const muted = () => !!process.env.VITEST && !process.env.BUGBASH_NOTIFY_TEST;

/**
 * Sends a notification on every enabled channel for that event. Never throws: a failing channel is reported in
 * the result and otherwise ignored, so notifications can't break a run.
 */
export async function notify(n: NotifyInput, opts: { only?: ('macos' | 'inbox' | 'slack')[]; force?: boolean } = {}) {
  const result: Record<string, 'sent' | 'off' | string> = {};
  if (muted()) return { muted: true, result };
  const s = readSettings();
  if (!opts.force && !s.events[n.event]) return { muted: false, result: { event: 'off' } };
  const path = process.env.BUGBASH_JOB_ID ? `/jobs/${encodeURIComponent(process.env.BUGBASH_JOB_ID)}` : n.path ?? null;
  const full: Notification = { id: `N-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`, at: new Date().toISOString(), event: n.event, level: n.level ?? 'info', title: n.title.slice(0, 200), body: n.body.slice(0, 1200), path, read: false };
  const url = full.path ? s.web_url.replace(/\/$/, '') + full.path : null;
  const want = (c: 'macos' | 'inbox' | 'slack') => (!opts.only || opts.only.includes(c)) && (opts.force ? true : s.channels[c]);

  if (want('inbox')) {
    try {
      mkdirSync(home(), { recursive: true });
      appendFileSync(inboxFile(), JSON.stringify(full) + '\n');
      result.inbox = 'sent';
    } catch (e) {
      result.inbox = (e as Error).message;
    }
  } else result.inbox = 'off';

  if (want('macos')) {
    if (process.platform !== 'darwin') result.macos = 'not macOS';
    else result.macos = await sendMacNotification(home(), {
      id: full.id, title: full.title, body: full.body.slice(0, 240),
      url: url ?? s.web_url.replace(/\/$/, '') + '/jobs',
    });
  } else result.macos = 'off';

  if (want('slack')) {
    if (!s.slack_webhook || !SLACK_WEBHOOK.test(s.slack_webhook)) result.slack = 'no webhook set';
    else {
      const icon = { info: ':information_source:', success: ':white_check_mark:', warn: ':warning:', error: ':x:' }[full.level];
      try {
        const res = await fetch(s.slack_webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `${icon} *${full.title}*\n${full.body}${url ? `\n<${url}|Open in TurboBrocolli>` : ''}` }),
          signal: AbortSignal.timeout(8000),
        });
        result.slack = res.ok ? 'sent' : `HTTP ${res.status}`;
      } catch (e) {
        result.slack = (e as Error).message;
      }
    }
  } else result.slack = 'off';
  return { muted: false, result, notification: full };
}

/**
 * Fire-and-forget: hands the notification to a detached process so a CLI that is about to exit (or a run that is
 * busy) is never delayed and the notification still goes out.
 */
export function notifyDetached(n: NotifyInput) {
  if (muted()) return;
  try {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./send.ts', import.meta.url)), Buffer.from(JSON.stringify(n)).toString('base64')], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  } catch {}
}
