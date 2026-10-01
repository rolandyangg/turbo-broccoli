import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { FindingsFile, SCHEMA_VERSION, type Finding, type RootCauseGroup } from './schema.js';

export function workspaceFor(repoPath: string | null, out?: string | null): string {
  const ws = resolve(out ?? (repoPath ? join(repoPath, '.bugbash') : '.bugbash'));
  mkdirSync(join(ws, 'runs'), { recursive: true });
  keepPrivate(ws);
  registerWorkspace(ws);
  return ws;
}

/**
 * A workspace (runs, screenshots, memory, proposals) is private to this machine and must never be committed to the
 * target repo. `*` in its own .gitignore ignores everything inside (the file included); older workspaces that only
 * ignored runs/ tmp/ jobs/ are upgraded. The repo's local, uncommitted .git/info/exclude also gets an entry.
 */
export function keepPrivate(ws: string) {
  const gi = join(ws, '.gitignore');
  const want = '# bugbash workspace: private to this machine, never commit\n*\n';
  try {
    if (!existsSync(gi) || readFileSync(gi, 'utf8') !== want) writeFileSync(gi, want);
  } catch {}
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // --git-common-dir is relative to the cwd unless asked for an absolute path (worktrees share the main exclude).
    const gitDir = resolve(ws, execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    // Compare real paths: symlinked (/var → /private/var) or differently-cased folders otherwise look unrelated.
    const rel = relative(realpathSync.native(top), realpathSync.native(ws)).split('\\').join('/');
    if (!rel || rel.startsWith('..')) return;
    const exclude = join(gitDir, 'info', 'exclude');
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    const line = `/${rel}/`;
    if (!cur.split('\n').includes(line)) {
      mkdirSync(dirname(exclude), { recursive: true });
      writeFileSync(exclude, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}# bugbash workspace (private)\n${line}\n`);
    }
  } catch {} // not a git repo: nothing to protect
}

export const REGISTRY = join(homedir(), '.bugbash', 'workspaces.json');

/** Remembers every workspace so viewers (the web app) can find all runs on this machine. */
export function registerWorkspace(ws: string) {
  try {
    mkdirSync(dirname(REGISTRY), { recursive: true });
    const list: string[] = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, 'utf8')) : [];
    if (!list.includes(ws)) writeFileSync(REGISTRY, JSON.stringify([...list, ws], null, 2));
  } catch {}
}

export function registeredWorkspaces(): string[] {
  try {
    return existsSync(REGISTRY) ? (JSON.parse(readFileSync(REGISTRY, 'utf8')) as string[]).filter((w) => existsSync(w)) : [];
  } catch {
    return [];
  }
}

export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

export function createRunDir(ws: string, runId: string): string {
  const dir = join(ws, 'runs', runId);
  for (const d of ['', 'shots', 'videos', 'traces', 'repros', 'sessions', 'transcripts']) mkdirSync(join(dir, d), { recursive: true });
  const latest = join(ws, 'latest');
  try {
    if (existsSync(latest) || lstatSync(latest, { throwIfNoEntry: false })) unlinkSync(latest);
  } catch {}
  try {
    symlinkSync(join('runs', runId), latest);
  } catch {
    writeFileSync(latest, runId);
  }
  return dir;
}

export function listRuns(ws: string): string[] {
  const d = join(ws, 'runs');
  return existsSync(d) ? readdirSync(d).filter((x) => existsSync(join(d, x, 'run.json'))).sort() : [];
}

export function resolveRunDir(ws: string, run?: string | null): string {
  if (run) {
    const direct = resolve(run);
    if (existsSync(join(direct, 'run.json'))) return direct;
    const d = join(ws, 'runs', run);
    if (existsSync(d)) return d;
    throw new Error(`Run not found: ${run}`);
  }
  const runs = listRuns(ws);
  if (!runs.length) throw new Error(`No runs in ${ws}. Run \`bugbash explore <target>\` first.`);
  return join(ws, 'runs', runs[runs.length - 1]);
}

export interface RunInfo {
  run_id: string;
  /** Human-friendly display name; the run id/folder never changes. */
  name?: string | null;
  target: string;
  base_url: string;
  target_kind: string;
  repo_path: string | null;
  workspace: string;
  started_at: string;
  ended_at: string | null;
  head_commit: string | null;
  config: unknown;
  stop_reason: string | null;
  lead_decisions: string[];
  jobs: unknown[];
  stages: Record<string, { at: string; note?: string }>;
}

export function readRun(runDir: string): RunInfo {
  return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
}
export function writeRun(runDir: string, info: RunInfo) {
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(info, null, 2));
}

export function readFindings(runDir: string): FindingsFile | null {
  const f = join(runDir, 'findings.json');
  if (!existsSync(f)) return null;
  return FindingsFile.parse(JSON.parse(readFileSync(f, 'utf8')));
}

export function allFindings(ff: FindingsFile): Finding[] {
  return ff.groups.flatMap((g) => g.findings);
}

export function rollup(g: RootCauseGroup): RootCauseGroup {
  const r: Record<string, number> = {};
  for (const f of g.findings) r[f.status] = (r[f.status] ?? 0) + 1;
  g.status_rollup = r;
  return g;
}

/** Writes the nested findings.json and the flat findings.flat.jsonl side by side. */
export function writeFindings(runDir: string, ff: Omit<FindingsFile, 'schemaVersion'>) {
  const data = FindingsFile.parse({ schemaVersion: SCHEMA_VERSION, ...ff, groups: ff.groups.map(rollup) });
  writeFileSync(join(runDir, 'findings.json'), JSON.stringify(data, null, 2));
  writeFileSync(join(runDir, 'findings.flat.jsonl'), allFindings(data).map((f) => JSON.stringify(f)).join('\n') + '\n');
  return data;
}

export function findById(ff: FindingsFile, id: string): { finding: Finding; group: RootCauseGroup } | null {
  for (const g of ff.groups) for (const f of g.findings) if (f.id === id) return { finding: f, group: g };
  return null;
}

/** Sanitises a run display name (single line, no control characters, max 80 chars). Empty → null. */
export function cleanRunName(name: string | null | undefined): string | null {
  const n = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return n || null;
}

export function renameRun(runDir: string, name: string | null | undefined): RunInfo {
  const info = readRun(runDir);
  info.name = cleanRunName(name);
  writeRun(runDir, info);
  return info;
}
