import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { execa } from 'execa';
import { home } from '../notify/notify.js';

/**
 * Scheduled bug bashes as per-user macOS LaunchAgents. Each schedule is a plist in ~/Library/LaunchAgents
 * (com.turbobrocolli.<id>) that runs `bugbash explore <target> --preset <p> --then-triage`. launchd only runs
 * them while the Mac is awake and the user is logged in (a missed time runs once at wake).
 */
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const LABEL_PREFIX = 'com.turbobrocolli.';

export interface Schedule {
  id: string;
  name: string;
  target: string;
  preset: string;
  cron: string;
  repo: string | null;
  enabled: boolean;
  created_at: string;
}
export interface LastResult {
  state: 'running' | 'succeeded' | 'failed';
  at: string;
  ended_at: string | null;
  run_dir: string | null;
  error: string | null;
  pid?: number;
}

const storeFile = () => join(home(), 'schedules.json');
const logDir = () => join(home(), 'schedules');
export const agentsDir = () => process.env.BUGBASH_LAUNCH_AGENTS || join(homedir(), 'Library', 'LaunchAgents');
const launchctl = () => process.env.BUGBASH_LAUNCHCTL || 'launchctl';
export const labelOf = (id: string) => `${LABEL_PREFIX}${id}`;
export const plistPath = (id: string) => join(agentsDir(), `${labelOf(id)}.plist`);
export const logPath = (id: string) => join(logDir(), `${id}.log`);
const lastPath = (id: string) => join(logDir(), `${id}.last.json`);

export function listSchedules(): Schedule[] {
  try {
    return existsSync(storeFile()) ? (JSON.parse(readFileSync(storeFile(), 'utf8')) as Schedule[]) : [];
  } catch {
    return [];
  }
}
function saveSchedules(s: Schedule[]) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(storeFile(), JSON.stringify(s, null, 2) + '\n');
}
export function getSchedule(id: string) {
  const s = listSchedules().find((x) => x.id === id);
  if (!s) throw new Error(`No schedule ${id}`);
  return s;
}
export function lastResult(id: string): LastResult | null {
  let r: LastResult;
  try {
    r = JSON.parse(readFileSync(lastPath(id), 'utf8')) as LastResult;
  } catch {
    return null;
  }
  // A run killed from outside (launchctl kill, sleep, reboot) never records its end: don't show it as running forever.
  if (r.state === 'running' && r.pid && !alive(r.pid)) return { ...r, state: 'failed', error: 'Interrupted before it finished' };
  return r;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/** Called by `explore --schedule <id>` at start and end, so the Schedules page can show the last result. */
export function recordLast(id: string, r: LastResult) {
  mkdirSync(logDir(), { recursive: true });
  writeFileSync(lastPath(id), JSON.stringify({ ...r, pid: r.pid ?? process.pid }, null, 2));
}

// ---------------- cron → launchd ----------------
export type CalendarEntry = Partial<Record<'Minute' | 'Hour' | 'Day' | 'Month' | 'Weekday', number>>;

const FIELD: { key: keyof CalendarEntry; min: number; max: number }[] = [
  { key: 'Minute', min: 0, max: 59 },
  { key: 'Hour', min: 0, max: 23 },
  { key: 'Day', min: 1, max: 31 },
  { key: 'Month', min: 1, max: 12 },
  { key: 'Weekday', min: 0, max: 7 },
];
const MACROS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };

/**
 * Translates a simple cron expression to launchd StartCalendarInterval entries. Supported per field: `*`, a
 * number, a list (1,3,5) and a range (1-5); minutes must be fixed numbers. Steps (`*\/15`) and names (MON) are not
 * supported. Throws with a readable reason otherwise.
 */
export function cronToCalendar(cron: string): CalendarEntry[] {
  const expr = MACROS[cron.trim()] ?? cron.trim();
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) throw new Error('Use 5 fields: minute hour day-of-month month day-of-week (e.g. "0 2 * * 1-5")');
  const values = parts.map((p, i) => {
    const f = FIELD[i];
    if (p === '*') {
      if (f.key === 'Minute') throw new Error('Minute must be a number (launchd has no "every minute")');
      return null;
    }
    if (/[/A-Za-z]/.test(p)) throw new Error(`"${p}": steps (*/n) and names aren't supported; use numbers, lists or ranges`);
    const out = new Set<number>();
    for (const item of p.split(',')) {
      const m = item.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`Can't read "${item}" in the ${f.key.toLowerCase()} field`);
      const a = Number(m[1]);
      const b = m[2] === undefined ? a : Number(m[2]);
      if (a < f.min || b > f.max || a > b) throw new Error(`${f.key} must be between ${f.min} and ${f.max}`);
      for (let v = a; v <= b; v++) out.add(f.key === 'Weekday' && v === 7 ? 0 : v);
    }
    return [...out].sort((x, y) => x - y);
  });
  let entries: CalendarEntry[] = [{}];
  values.forEach((vs, i) => {
    if (!vs) return;
    entries = entries.flatMap((e) => vs.map((v) => ({ ...e, [FIELD[i].key]: v })));
  });
  if (entries.length > 200) throw new Error('That expression expands to too many launchd entries; simplify it');
  return entries;
}

/** Next time any entry matches, after `from` (minute resolution, searched up to 400 days ahead). */
export function nextRun(cron: string, from = new Date()): Date | null {
  let entries: CalendarEntry[];
  try {
    entries = cronToCalendar(cron);
  } catch {
    return null;
  }
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 400 * 24 * 60; i++) {
    const ok = entries.some((e) => (e.Minute === undefined || e.Minute === d.getMinutes()) && (e.Hour === undefined || e.Hour === d.getHours()) && (e.Day === undefined || e.Day === d.getDate()) && (e.Month === undefined || e.Month === d.getMonth() + 1) && (e.Weekday === undefined || e.Weekday === d.getDay()));
    if (ok) return d;
    // Skip whole hours when the hour can't match (keeps the search fast).
    if (entries.every((e) => e.Hour !== undefined && e.Hour !== d.getHours())) {
      d.setMinutes(0);
      d.setHours(d.getHours() + 1);
    } else d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Weekdays at 02:00", "Every day at 09:30", … for the UI and CLI. */
export function describeCron(cron: string): string {
  let entries: CalendarEntry[];
  try {
    entries = cronToCalendar(cron);
  } catch (e) {
    return (e as Error).message;
  }
  const times = [...new Set(entries.map((e) => (e.Hour === undefined ? `every hour at :${String(e.Minute).padStart(2, '0')}` : `${String(e.Hour).padStart(2, '0')}:${String(e.Minute).padStart(2, '0')}`)))];
  const wd = [...new Set(entries.map((e) => e.Weekday).filter((x) => x !== undefined))] as number[];
  const dom = [...new Set(entries.map((e) => e.Day).filter((x) => x !== undefined))];
  const months = [...new Set(entries.map((e) => e.Month).filter((x) => x !== undefined))] as number[];
  const days = wd.length ? (wd.length === 5 && [1, 2, 3, 4, 5].every((x) => wd.includes(x)) ? 'Weekdays' : wd.sort().map((x) => DAYS[x]).join(', ')) : dom.length ? `Day ${dom.join(', ')} of the month` : 'Every day';
  return `${days}${months.length ? ` in ${months.map((m) => MONTHS[m - 1]).join(', ')}` : ''} at ${times.join(', ')}`;
}

// ---------------- plist ----------------
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function commandOf(s: Schedule): string[] {
  return [process.execPath, join(ROOT, 'bin', 'bugbash.js'), 'explore', s.target, '--preset', s.preset, '--then-triage', '--name', `${s.name} (scheduled)`, '--schedule', s.id, ...(s.repo ? ['--repo', s.repo] : [])];
}
export function plistFor(s: Schedule): string {
  const cal = cronToCalendar(s.cron);
  const dict = (e: CalendarEntry) => `\t\t<dict>\n${Object.entries(e)
    .map(([k, v]) => `\t\t\t<key>${k}</key>\n\t\t\t<integer>${v}</integer>`)
    .join('\n')}\n\t\t</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(labelOf(s.id))}</string>
\t<key>ProgramArguments</key>
\t<array>
${commandOf(s)
  .map((a) => `\t\t<string>${xml(a)}</string>`)
  .join('\n')}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(ROOT)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xml(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string>
\t\t<key>HOME</key>
\t\t<string>${xml(homedir())}</string>
\t</dict>
\t<key>StartCalendarInterval</key>
\t<array>
${cal.map(dict).join('\n')}
\t</array>
\t<key>StandardOutPath</key>
\t<string>${xml(logPath(s.id))}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logPath(s.id))}</string>
\t<key>ProcessType</key>
\t<string>Background</string>
</dict>
</plist>
`;
}

const uid = () => (process.getuid ? process.getuid() : 501);

async function install(s: Schedule) {
  mkdirSync(agentsDir(), { recursive: true });
  mkdirSync(logDir(), { recursive: true });
  writeFileSync(plistPath(s.id), plistFor(s));
  const lint = await execa('plutil', ['-lint', plistPath(s.id)], { reject: false });
  if (lint.exitCode !== 0) throw new Error(`plist failed validation: ${lint.stdout || lint.stderr}`);
  await execa(launchctl(), ['bootout', `gui/${uid()}/${labelOf(s.id)}`], { reject: false }); // reload if present
  const r = await execa(launchctl(), ['bootstrap', `gui/${uid()}`, plistPath(s.id)], { reject: false });
  if (r.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr || r.stdout}`);
}
async function uninstall(id: string) {
  await execa(launchctl(), ['bootout', `gui/${uid()}/${labelOf(id)}`], { reject: false });
  rmSync(plistPath(id), { force: true });
}

export interface NewSchedule {
  name?: string | null;
  target: string;
  preset: string;
  cron: string;
  repo?: string | null;
  enabled?: boolean;
}
export async function addSchedule(n: NewSchedule): Promise<Schedule> {
  if (!n.target?.trim()) throw new Error('target is required');
  if (!/^[\w-]{1,40}$/.test(n.preset)) throw new Error('Bad preset id');
  cronToCalendar(n.cron); // validate
  // launchd runs from the repo root: make local paths absolute now.
  const target = /^https?:\/\//.test(n.target.trim()) || isAbsolute(n.target.trim()) || !existsSync(resolve(n.target.trim())) ? n.target.trim() : resolve(n.target.trim());
  const s: Schedule = { id: randomBytes(4).toString('hex'), name: (n.name?.trim() || `Nightly ${n.target.split('/').filter(Boolean).pop()}`).slice(0, 80), target, preset: n.preset, cron: n.cron.trim(), repo: n.repo?.trim() || null, enabled: n.enabled !== false, created_at: new Date().toISOString() };
  if (s.enabled) await install(s);
  saveSchedules([...listSchedules(), s]);
  return s;
}
export async function setEnabled(id: string, enabled: boolean) {
  const all = listSchedules();
  const s = all.find((x) => x.id === id);
  if (!s) throw new Error(`No schedule ${id}`);
  if (enabled) await install(s);
  else await uninstall(id);
  s.enabled = enabled;
  saveSchedules(all);
  return s;
}
export async function removeSchedule(id: string) {
  getSchedule(id);
  await uninstall(id);
  saveSchedules(listSchedules().filter((x) => x.id !== id));
  rmSync(lastPath(id), { force: true });
}
/** Runs a schedule now, detached, with the same command and log file launchd would use. */
export function runNow(id: string) {
  const s = getSchedule(id);
  mkdirSync(logDir(), { recursive: true });
  const fd = openSync(logPath(id), 'a');
  const [cmd, ...args] = commandOf(s);
  const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], env: process.env });
  closeSync(fd);
  child.unref();
  return { pid: child.pid ?? 0 };
}

/** Whether launchd currently has the agent loaded (best effort). */
export async function isLoaded(id: string) {
  const r = await execa(launchctl(), ['print', `gui/${uid()}/${labelOf(id)}`], { reject: false });
  return r.exitCode === 0;
}
