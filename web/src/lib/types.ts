// Shapes returned by the bugbash web API. Finding/group types come straight from the agent's schema.
export type { Finding, RootCauseGroup, FindingsFile, Step } from '../../../src/store/schema.ts';
export type { JobEvent, JobStatus } from '../../../src/jobs/events.ts';
import type { Finding, FindingsFile, RootCauseGroup } from '../../../src/store/schema.ts';
import type { JobStatus } from '../../../src/jobs/events.ts';

export interface RunSummary {
  ws: string;
  ws_path: string;
  run: string;
  name: string | null;
  target: string;
  target_key: string;
  base_url: string;
  target_kind: string;
  repo_path: string | null;
  started_at: string;
  ended_at: string | null;
  stop_reason: string | null;
  sessions: number;
  triaged: boolean;
  live: boolean;
  counts: { total: number; active: number; functional?: number; archived?: number; groups: number; by_severity: Record<string, number>; by_status: Record<string, number>; with_video: number };
  raw_findings: number;
}

export interface JobView extends JobStatus {
  alive: boolean;
  dir: string;
  run: { ws: string; run: string } | null;
  log_tail: string | null;
}

export interface CampaignJob {
  id: string;
  kind: string;
  goal: string;
  persona: string | null;
  browser: string;
  pages: string[];
  status: string;
  started_at: string | null;
  ended_at: string | null;
  new_findings: number | null;
  total_findings: number | null;
  tool_calls: number | null;
  summary: string | null;
  error: string | null;
}

export interface RunDetail {
  summary: RunSummary;
  run: {
    run_id: string;
    name?: string | null;
    target: string;
    base_url: string;
    target_kind: string;
    repo_path: string | null;
    workspace: string;
    started_at: string;
    ended_at: string | null;
    head_commit: string | null;
    stop_reason: string | null;
    lead_decisions: string[];
    jobs: CampaignJob[] | Record<string, unknown>[];
    stages: Record<string, { at: string; note?: string }>;
    config: Record<string, unknown>;
  };
  findings: FindingsFile | null;
  campaign: { phase: string; decisions: string[]; jobs: CampaignJob[]; budget: Record<string, number>; unique_findings: number; stop_reason: string | null; updated_at: string } | null;
  coverage: {
    page: string;
    states: number;
    interactives_seen: number;
    interactives_tried: number;
    untried_examples: string[];
    widths_tested: number[];
    widths_untested: number[];
    variants_tested: string[];
    browsers_tested: string[];
    browsers_untested: string[];
    strategies_untried: string[];
  }[];
  hypotheses: { session: string; page: string; hypothesis: string; strategy: string | null; outcome: string; note: string; at: string }[];
  raw_findings: { session: string; type: string; title: string; page: string; severity: string; confidence: number; browser: string; at: string }[];
  code_intel: {
    framework: string | null;
    breakpoints: number[];
    routes: string[];
    components: { name: string; file: string; usages: number; usedIn: string[] }[];
    changedFiles: string[];
    hypotheses: { text: string; widths: number[]; selector: string | null; source: string }[];
    risky: { file: string; line: number | null; selector: string; media: string | null; issue: string; decl: string }[];
  } | null;
  notes: string;
  jobs: JobView[];
}

export interface BugDetail {
  group_blockers?: import('../../../src/fix/groupBlockers.ts').GroupFixBlocker[];
  manually_verified?: boolean;
  regressions?: import('../../../src/store/schema.ts').LayoutRegression[];
  finding: Finding;
  group: Omit<RootCauseGroup, 'findings'> & { findings: Pick<Finding, 'id' | 'title' | 'status' | 'severity' | 'type' | 'page'>[] };
  groups: { id: string; summary: string; count: number }[];
  spec: string | null;
  after_shot: string | null;
  pr_body: string | null;
  jobs: JobView[];
  reports?: BugReportView[];
  run: { target: string; name: string | null; repo_path: string | null; base_url: string };
}

export interface BugReportView {
  id: string;
  at: string;
  category: string;
  text: string;
  status: 'investigating' | 'done' | 'failed';
  job_id: string | null;
  diagnosis: { stage: string; summary: string; is_real_bug: boolean | null; recommended_action: string } | null;
  proposals: string[];
  error: string | null;
}

export interface TranscriptItem {
  kind: 'text' | 'tool' | 'result';
  id?: string;
  name?: string;
  text?: string;
  input?: unknown;
  is_error?: boolean;
  image?: boolean;
}

export interface BranchInfo {
  exists: boolean;
  branch: string;
  base: string | null;
  git_root: string | null;
  head: string | null;
  ahead: number | null;
  behind: number | null;
  commits: { sha: string; subject: string; author: string; date: string }[];
  diff_stat: string;
  files: { file: string; added: number; removed: number }[];
  patch: string;
  patch_truncated: boolean;
  worktree: string | null;
  pr: { number: number; url: string; state: string; isDraft: boolean; title: string; reviewDecision: string | null; checks: { name: string; state: string }[] } | null;
}
