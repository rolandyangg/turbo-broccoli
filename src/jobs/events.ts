import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { notifyDetached } from '../notify/notify.js';

/**
 * File-backed job progress, so any UI (or a later process) can follow a fix/explore/triage job:
 *   <runDir>/jobs/<jobId>/status.json   current state (rewritten on every change)
 *   <runDir>/jobs/<jobId>/events.jsonl  append-only event stream
 */
export type JobKind = 'fix' | 'explore' | 'triage' | 'reproduce' | 'retro' | 'improve';
export type JobState = 'running' | 'succeeded' | 'failed' | 'cancelled';
const KIND_LABEL: Record<JobKind, string> = { fix: 'Fix', explore: 'Bug bash', triage: 'Triage', reproduce: 'Reproduction', retro: 'Retrospective', improve: 'Improvement' };

export interface JobEvent {
  t: string;
  stage: string;
  level: 'info' | 'success' | 'warn' | 'error' | 'agent';
  msg: string;
  data?: Record<string, unknown>;
}

export interface JobStatus {
  id: string;
  kind: JobKind;
  state: JobState;
  stage: string;
  pid: number;
  run_dir: string | null;
  finding_ids: string[];
  scope: string | null;
  branch: string | null;
  base: string | null;
  worktree: string | null;
  pr_url: string | null;
  verified: boolean | null;
  also_fixed: string[];
  options: Record<string, unknown>;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  error: string | null;
  summary: string | null;
}

export function newJobId(kind: JobKind) {
  return `${kind}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}

export class JobReporter {
  readonly dir: string;
  status: JobStatus;

  constructor(jobsRoot: string, id: string, kind: JobKind, init: Partial<JobStatus> = {}) {
    // A launcher (e.g. the web app) can pin where job files go, so it can find them without knowing the workspace.
    this.dir = join(process.env.BUGBASH_JOB_DIR || jobsRoot, id);
    mkdirSync(this.dir, { recursive: true });
    const now = new Date().toISOString();
    this.status = {
      id,
      kind,
      state: 'running',
      stage: 'start',
      pid: process.pid,
      run_dir: null,
      finding_ids: [],
      scope: null,
      branch: null,
      base: null,
      worktree: null,
      pr_url: null,
      verified: null,
      also_fixed: [],
      options: {},
      started_at: now,
      updated_at: now,
      ended_at: null,
      error: null,
      summary: null,
      ...init,
    };
    this.flush();
  }

  private flush() {
    this.status.updated_at = new Date().toISOString();
    writeFileSync(join(this.dir, 'status.json'), JSON.stringify(this.status, null, 2));
  }

  update(patch: Partial<JobStatus>) {
    Object.assign(this.status, patch);
    this.flush();
  }

  event(stage: string, msg: string, level: JobEvent['level'] = 'info', data?: Record<string, unknown>) {
    const e: JobEvent = { t: new Date().toISOString(), stage, level, msg, ...(data ? { data } : {}) };
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(e) + '\n');
    if (level !== 'agent' && stage !== this.status.stage) this.status.stage = stage;
    this.flush();
  }

  finish(state: Exclude<JobState, 'running'>, patch: Partial<JobStatus> = {}) {
    this.update({ ...patch, state, ended_at: new Date().toISOString() });
    this.event(state === 'succeeded' ? 'done' : state, patch.summary ?? patch.error ?? state, state === 'succeeded' ? 'success' : 'error');
    // Every failed job (crash, verification failure, …) is a "failures & limits" notification.
    if (state === 'failed') notifyDetached({ event: 'failure', level: 'error', title: `${KIND_LABEL[this.status.kind]} failed${this.status.scope ? `: ${this.status.scope}` : ''}`, body: String(this.status.error ?? patch.error ?? 'Unknown error').slice(0, 600), path: `/jobs/${this.status.id}` });
  }
}

export function readJob(dir: string): JobStatus | null {
  const f = join(dir, 'status.json');
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function listJobs(jobsRoot: string): JobStatus[] {
  if (!existsSync(jobsRoot)) return [];
  return readdirSync(jobsRoot)
    .map((d) => readJob(join(jobsRoot, d)))
    .filter((j): j is JobStatus => !!j)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/** Short human description of a Claude stream event for live activity feeds. */
export function describeAgentEvent(e: { type: string; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } }): { msg: string; data: Record<string, unknown> }[] {
  if (e.type !== 'assistant') return [];
  const out: { msg: string; data: Record<string, unknown> }[] = [];
  for (const c of e.message?.content ?? []) {
    if (c.type === 'tool_use') {
      const input = (c.input ?? {}) as Record<string, unknown>;
      const target = (input.file_path ?? input.path ?? input.pattern ?? input.ref ?? input.url ?? '') as string;
      const name = String(c.name ?? '').replace(/^mcp__\w+__/, '');
      out.push({ msg: `${name}${target ? ` ${String(target).replace(/^.*\/(?=[^/]+\/[^/]+$)/, '…/')}` : ''}`, data: { tool: name, input } });
    } else if (c.type === 'text' && c.text?.trim()) out.push({ msg: c.text.trim().slice(0, 400), data: { text: true } });
  }
  return out;
}
