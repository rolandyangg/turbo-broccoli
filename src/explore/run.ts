import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadConfig, type Config } from '../config.js';
import type { ResolvedTarget } from '../target/resolve.js';
import { workspaceFor, newRunId, createRunDir, writeRun, cleanRunName, type RunInfo } from '../store/store.js';
import { scanRepo } from './codeIntel.js';
import { Campaign } from './campaign.js';
import { Memory } from '../memory/siteMemory.js';

export interface ExploreOptions {
  targetArg: string;
  target: ResolvedTarget;
  out?: string | null;
  overrides: Partial<Config>;
  noLead?: boolean;
  codeIntel?: boolean;
  log: (m: string) => void;
  onRun?: (runDir: string, runId: string) => void;
  name?: string | null;
  /** Preset config layered under the explicit overrides. */
  preset?: Partial<Config>;
  /** The person's instructions for the lead and explorers. */
  instructions?: string | null;
}

export async function exploreRun(o: ExploreOptions): Promise<{ runDir: string; runId: string; workspace: string; config: Config }> {
  const { target, log } = o;
  const ws = workspaceFor(target.repoPath, o.out);
  const config = loadConfig(target.repoPath ?? process.cwd(), o.overrides, o.preset);
  // Explicit flags win; otherwise the (preset/config) choice applies.
  const noLead = o.noLead ?? !config.lead;
  const useIntel = o.codeIntel ?? config.codeIntel;
  const runId = newRunId();
  const runDir = createRunDir(ws, runId);
  const memory = new Memory(ws);
  const intel = useIntel && target.repoPath ? scanRepo(target.repoPath, memory.site().lastCommit) : null;
  if (intel) writeFileSync(join(runDir, 'code-intel.json'), JSON.stringify(intel, null, 2));
  const info: RunInfo = {
    run_id: runId,
    name: cleanRunName(o.name ?? null),
    target: o.targetArg,
    base_url: target.baseUrl,
    target_kind: target.kind,
    repo_path: target.repoPath,
    workspace: ws,
    started_at: new Date().toISOString(),
    ended_at: null,
    head_commit: intel?.headCommit ?? null,
    config,
    stop_reason: null,
    lead_decisions: [],
    jobs: [],
    stages: { explore: { at: new Date().toISOString(), note: intel ? 'white-box (code intel)' : 'black-box' } },
  };
  writeRun(runDir, info);
  o.onRun?.(runDir, runId);
  log(`Run ${runId} → ${runDir}`);
  log(intel ? `Code intel: ${intel.breakpoints.length} breakpoints, ${intel.risky.length} risky rules, ${intel.components.length} shared components, ${intel.hypotheses.length} hypothesis seeds` : 'Black-box mode (no source).');

  const campaign = new Campaign({ runId, runDir, workspace: ws, baseUrl: target.baseUrl, config, intel, log, noLead, instructions: o.instructions ?? null });
  const res = await campaign.run();
  info.ended_at = new Date().toISOString();
  info.stop_reason = res.stopReason;
  info.lead_decisions = res.leadDecisions;
  info.jobs = res.jobs;
  writeRun(runDir, info);
  const site = memory.site();
  site.lastRun = runId;
  site.lastCommit = intel?.headCommit ?? site.lastCommit;
  site.routes = [...new Set([...site.routes, ...(intel?.routes ?? [])])];
  memory.saveSite(site);
  log(`Explore finished: ${res.jobs.length} sessions. Stop reason: ${res.stopReason}`);
  return { runDir, runId, workspace: ws, config };
}
