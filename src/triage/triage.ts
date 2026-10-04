import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import pLimit from 'p-limit';
import { Config } from '../config.js';
import { Finding, RawFinding, categoryOf, type RootCauseGroup, type Step } from '../store/schema.js';
import { readRun, writeRun, writeFindings, readFindings, allFindings } from '../store/store.js';
import { clusterFindings, type Cluster } from './cluster.js';
import { BrowserPool, replay, replayAndCheck as replayAndCheckRaw, minimize, checkPresence, DETECTABLE, type DefectSpec } from './replay.js';
import { annotateDefect } from './annotate.js';
import { recordVideo } from './video.js';
import { describeStep, normalizeSteps, suffixFromLastGoto, finalEnvironment } from './steps.js';
import { writeReproSpec } from './reproSpec.js';
import { reviewFinding, reviewVideo, proposeRootCauses, type ReviewVerdict } from './review.js';
import { SourceIndex } from './sourceHints.js';
import { score } from './score.js';
import { Memory } from '../memory/siteMemory.js';
import { loadCalibration } from '../memory/calibration.js';
import { summarizeIntel, type CodeIntel } from '../explore/codeIntel.js';
import { writeReport } from '../store/report.js';

export interface TriageOptions {
  runDir: string;
  baseUrl: string;
  log: (m: string) => void;
  video?: boolean;
  review?: boolean;
  reproRuns?: number;
  concurrency?: number;
}

const TEMPORAL_TYPES = new Set(['layout-shift', 'broken-state']);

/** Per-finding triage telemetry, written to triage-stats.json for the observability dashboard. */
export interface TriageFindingStat {
  id: string;
  type: string;
  ms: number;
  replays: number;
  minimize_tries: number;
  steps_original: number;
  steps_minimal: number;
  presence: 'present' | 'absent' | 'unverifiable';
  rate: string | null;
  video: boolean;
  video_rerecorded: boolean;
  reviewer: 'defect' | 'not_defect' | 'unavailable' | 'skipped';
  status: string;
}

function readJsonl<T>(file: string, parse: (x: unknown) => T): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [parse(JSON.parse(l))];
      } catch {
        return [];
      }
    });
}

export async function triageRun(o: TriageOptions) {
  const t0 = Date.now();
  const info = readRun(o.runDir);
  const config = Config.parse(info.config);
  const memory = new Memory(info.workspace);
  const calibration = loadCalibration(memory);
  const intel: CodeIntel | null = existsSync(join(o.runDir, 'code-intel.json')) ? JSON.parse(readFileSync(join(o.runDir, 'code-intel.json'), 'utf8')) : null;
  const raw = readJsonl(join(o.runDir, 'agent-findings.jsonl'), (x) => RawFinding.parse(x));
  if (!raw.length) {
    o.log('No findings recorded by explorers; nothing to triage.');
    writeFindings(o.runDir, { run_id: info.run_id, target: info.target, generated_at: new Date().toISOString(), groups: [] });
    writeReport(o.runDir);
    return;
  }
  const clusters = clusterFindings(raw);
  o.log(`Triage: ${raw.length} raw findings → ${clusters.length} unique`);
  const pool = new BrowserPool();
  const sources = info.repo_path ? new SourceIndex(info.repo_path, intel) : null;
  const ids = assignIds(clusters, memory);
  const limit = pLimit(o.concurrency ?? 3);
  let done = 0;

  const stats: TriageFindingStat[] = [];
  const nearby: RawFinding[] = [];
  const findings = await Promise.all(
    clusters.map((c) =>
      limit(async () => {
        const f = await triageCluster(c, ids.get(c.fingerprint)!, { ...o, config, pool, sources, calibration, memory, stats, nearby });
        o.log(`  [${++done}/${clusters.length}] ${f.id} ${f.status} conf=${f.confidence} ${f.reproduction.rate ?? 'n/a'} ${f.evidence_kind}${f.video ? ' +video' : ''} — ${f.title.slice(0, 70)}`);
        return f;
      }),
    ),
  );
  // Defects the reviewers saw next to the reported ones: replay them as new candidates (one pass, no further nearby collection).
  const seen = new Set(clusters.map((c) => c.fingerprint));
  const extra = clusterFindings(nearby).filter((c) => !seen.has(c.fingerprint));
  if (extra.length) {
    o.log(`Triage: reviewers saw ${extra.length} other defect(s) nearby; replaying them as new candidates`);
    const extraIds = assignIds(extra, memory, [...ids.values()]);
    let extraDone = 0;
    findings.push(
      ...(await Promise.all(
        extra.map((c) =>
          limit(async () => {
            const f = await triageCluster(c, extraIds.get(c.fingerprint)!, { ...o, config, pool, sources, calibration, memory, stats });
            o.log(`  [nearby ${++extraDone}/${extra.length}] ${f.id} ${f.status} conf=${f.confidence} ${f.reproduction.rate ?? 'n/a'} — ${f.title.slice(0, 70)}`);
            return f;
          }),
        ),
      )),
    );
  }
  await pool.close();

  // Root-cause grouping (advisory): every finding stays an individual record.
  o.log('Grouping findings by root cause…');
  const groupingOutcome = { value: 'structural' as 'llm' | 'structural' | 'skipped' };
  const groups = await groupFindings(findings, { intel, repo: info.repo_path, provider: config.provider, model: config.model, useLlm: o.review !== false, log: o.log, runDir: o.runDir, onMethod: (m) => (groupingOutcome.value = m) });

  // Re-triaging a run must not lose human decisions or fix records made since the last triage.
  carryOver(o.runDir, findings, o.log);

  // History tags (new / recurring / regressed).
  for (const f of findings) f.history_tag = memory.track(info.run_id, f);

  const ff = writeFindings(o.runDir, { run_id: info.run_id, target: info.target, generated_at: new Date().toISOString(), groups });
  writeFileSync(
    join(o.runDir, 'triage-stats.json'),
    JSON.stringify({ started_at: new Date(t0).toISOString(), ended_at: new Date().toISOString(), ms: Date.now() - t0, raw_findings: raw.length, clusters: clusters.length, groups: groups.length, grouping: groupingOutcome.value, findings: stats }, null, 2),
  );
  info.stages.triage = { at: new Date().toISOString(), note: `${findings.length} findings in ${groups.length} groups, ${Math.round((Date.now() - t0) / 1000)}s` };
  writeRun(o.runDir, info);
  const { html, md } = writeReport(o.runDir);
  const counts = allFindings(ff).reduce<Record<string, number>>((a, f) => ((a[f.status] = (a[f.status] ?? 0) + 1), a), {});
  o.log(`Triage done: ${JSON.stringify(counts)}`);
  o.log(`Report: ${html}`);
  o.log(`Summary: ${md}`);
}

const KEEP_STATUS = new Set(['confirmed', 'false_positive', 'fixing', 'fixed']);

function carryOver(runDir: string, findings: Finding[], log: (m: string) => void) {
  let prev: Finding[] = [];
  try {
    const ff = readFindings(runDir);
    prev = ff ? allFindings(ff) : [];
  } catch {
    return;
  }
  let n = 0;
  for (const f of findings) {
    const p = prev.find((x) => x.fingerprint === f.fingerprint) ?? prev.find((x) => x.id === f.id);
    if (!p) continue;
    if (p.fix) f.fix = p.fix;
    if (p.label_note) f.label_note = p.label_note;
    // The person's own sorting (to do / in progress / done / archived) survives re-triage.
    if (p.workflow && (p.workflow.state || p.workflow.archived)) {
      f.workflow = p.workflow;
      n++;
    }
    if (KEEP_STATUS.has(p.status)) {
      f.status = p.status;
      n++;
    }
  }
  if (n) log(`Kept ${n} status/label/fix record(s) from the previous triage`);
}

function assignIds(clusters: Cluster[], memory: Memory, taken: string[] = []): Map<string, string> {
  const known = memory.knownBugs();
  let max = [...known.map((b) => b.last_id), ...taken].reduce((m, id) => Math.max(m, parseInt(id.replace(/\D/g, ''), 10) || 0), 0);
  const out = new Map<string, string>();
  for (const c of clusters) {
    const k = known.find((b) => b.fingerprint === c.fingerprint);
    out.set(c.fingerprint, k ? k.last_id : `BB-${String(++max).padStart(4, '0')}`);
  }
  return out;
}

async function triageCluster(
  c: Cluster,
  id: string,
  o: TriageOptions & { config: Config; pool: BrowserPool; sources: SourceIndex | null; calibration: ReturnType<typeof loadCalibration>; memory: Memory; stats: TriageFindingStat[]; nearby?: RawFinding[] },
): Promise<Finding> {
  const startedAt = Date.now();
  let replays = 0;
  let minimizeTries = 0;
  let videoRerecorded = false;
  const replayAndCheck: typeof replayAndCheckRaw = (...a) => {
    replays++;
    return replayAndCheckRaw(...a);
  };
  const tdir = join(o.runDir, 'transcripts', 'triage');
  const rep = c.representative;
  const spec: DefectSpec = { type: rep.type, selector: rep.element.selector, relatedSelector: c.relatedSelector, signature: rep.element.signature };
  const rOpts = { baseUrl: o.baseUrl, browser: rep.environment.browser, initialViewport: rep.environment.viewport, guardrails: o.config.guardrails, pool: o.pool };
  const original = normalizeSteps(rep.trace);
  const notes: string[] = [];

  // 1. Does the recorded trace reproduce it?
  let steps = original;
  let presence: 'present' | 'absent' | 'unverifiable' = 'unverifiable';
  if (DETECTABLE.has(rep.type)) {
    const r = await replayAndCheck(original, spec, rOpts).catch((e) => ({ presence: 'absent' as const, candidate: null, error: String(e) }));
    presence = r.presence;
    if (r.error) notes.push(`replay error: ${r.error}`);
    // Other sessions may have better traces for the same bug.
    for (const m of c.members.filter((m) => m !== rep).slice(0, 2)) {
      if (presence === 'present') break;
      const alt = normalizeSteps(m.trace);
      const r2 = await replayAndCheck(alt, spec, { ...rOpts, browser: m.environment.browser }).catch(() => null);
      if (r2?.presence === 'present') {
        presence = 'present';
        steps = alt;
      }
    }
    // Inputs recorded after the navigation can mask load-time bugs (e.g. a keypress near a late layout shift):
    // try the environment + navigation alone, and the suffix since the last navigation.
    if (presence !== 'present') {
      const env = original.filter((s) => s.action === 'resize' || s.action === 'variant');
      const variants: Step[][] = [suffixFromLastGoto(original), normalizeSteps([...env, { action: 'goto', url: rep.url }])];
      for (const alt of variants) {
        if (JSON.stringify(alt) === JSON.stringify(steps)) continue;
        const r3 = await replayAndCheck(alt, spec, rOpts).catch(() => null);
        if (r3?.presence === 'present') {
          presence = 'present';
          steps = alt;
          notes.push('reproduced with a reduced trace (recorded inputs after navigation were not needed)');
          break;
        }
      }
    }
    // The explorer's judgment may have been visual even though a detector type was chosen.
    if (presence === 'absent' && !rep.detector) {
      presence = 'unverifiable';
      notes.push('Detectors do not flag this element; judged visually by the explorer (not auto-verifiable).');
    }
  }

  // 2. Minimize + measure reproduction rate.
  let minimal = presence === 'unverifiable' ? suffixFromLastGoto(steps) : steps;
  let rate: string | null = null;
  let reproScore: number | null = null;
  const runs = o.reproRuns ?? 3;
  if (presence === 'present') {
    const m = await minimize(steps, spec, rOpts).catch(() => ({ steps, tries: 0 }));
    minimizeTries = m.tries;
    replays += m.tries;
    minimal = m.steps;
    notes.push(`minimized ${steps.length} → ${minimal.length} steps in ${m.tries} replays`);
    let hits = 0;
    for (let i = 0; i < runs; i++) if ((await replayAndCheck(minimal, spec, rOpts).catch(() => null))?.presence === 'present') hits++;
    rate = `${hits}/${runs}`;
    reproScore = hits / runs;
  } else if (presence === 'absent') {
    rate = `0/1`;
    reproScore = 0;
    notes.push('Recorded trace did not reproduce the defect in a fresh browser.');
  }

  // 3. Annotate from a fresh replay of the minimal steps.
  const shots = { annotated: join(o.runDir, 'shots', `${id}-annotated.png`), crop: join(o.runDir, 'shots', `${id}-crop.png`), full: join(o.runDir, 'shots', `${id}-full.png`) };
  let metrics: Record<string, unknown> = { ...(rep.detector?.metrics ?? {}) };
  let bbox = rep.element.bbox;
  {
    const { driver, error } = await replay(minimal, rOpts);
    try {
      if (error) notes.push(`annotation replay error: ${error}`);
      if (presence === 'present') {
        const chk = await checkPresence(driver, spec);
        if (chk.candidate) {
          metrics = { ...chk.candidate.metrics, message: chk.candidate.message, related: chk.candidate.related };
          bbox = chk.candidate.bbox;
        }
      } else if (rep.type === 'layout-shift') await driver.page.waitForTimeout(2500);
      await annotateDefect(driver.page, { selector: spec.selector, relatedSelector: spec.relatedSelector, fallbackBBox: bbox, label: `${id}: ${rep.title}`, files: shots });
    } finally {
      await driver.close();
    }
  }

  const env = finalEnvironment(minimal, rep.environment.viewport);
  const target = rep.element.text ? `"${rep.element.text.slice(0, 50)}" (\`${rep.element.selector}\`)` : `\`${rep.element.selector ?? 'the highlighted area'}\``;
  const stepsHuman = [...minimal.map(describeStep), `Look at ${target}${rep.type === 'layout-shift' ? ' during the first seconds after load' : ''}.`];

  const f = Finding.parse({
    id,
    fingerprint: c.fingerprint,
    type: rep.type,
    category: rep.category ?? categoryOf(rep.type),
    title: rep.title,
    description: rep.description,
    severity: rep.severity,
    confidence: rep.confidence,
    confidence_breakdown: { explorer: Math.max(...c.members.map((m) => m.confidence)), detector: rep.detector?.confidence ?? null, repro: reproScore, notes },
    found_by: { persona: rep.persona, strategy: rep.strategy, hypothesis: rep.hypothesis, session: [...new Set(c.members.map((m) => m.session))].join(','), seeded_by_code_intel: c.members.some((m) => m.seeded_by_code_intel) },
    page: rep.page,
    also_seen: c.alsoSeen,
    browsers: c.browsers,
    viewports: c.viewports,
    element: { ...rep.element, bbox },
    metrics,
    reproduction: {
      rate,
      environment: { browser: rep.environment.browser, viewport: env.viewport, variant: { ...rep.environment.variant, ...env.variant }, persona: rep.persona ?? undefined },
      steps_human: stepsHuman,
      steps_minimal: minimal,
      steps_original: rep.trace,
    },
    evidence_kind: 'static',
    screenshots: { ...rel(o.runDir, shots), explorer: rep.screenshot ? relative(o.runDir, rep.screenshot) : null },
    source_hints: o.sources ? o.sources.hints({ selector: rep.element.selector, text: rep.element.text, type: rep.type }).map(({ file, line, reason }) => ({ file, line, reason })) : [],
  });

  // 4. Independent review.
  let verdict: ReviewVerdict | null = null;
  if (o.review !== false) {
    verdict = await reviewFinding(f, { runDir: o.runDir, provider: o.config.provider, model: o.config.model, transcriptPath: join(tdir, `review-${id}.jsonl`), images: [shots.crop, ...(rep.screenshot ? [rep.screenshot] : [])], viewport: shots.annotated, replayNote: presence === 'present' ? `detector re-confirmed the defect in ${rate} fresh replays` : presence === 'absent' ? 'the recorded steps did NOT reproduce it in a fresh browser' : 'not automatically verifiable; judge from the images' }).catch(() => null);
    if (verdict) {
      f.confidence_breakdown.reviewer = verdict.is_defect ? verdict.confidence : Math.min(verdict.confidence, 1 - verdict.confidence);
      f.severity = verdict.severity as Finding['severity'];
      f.reproduction.expected = verdict.expected;
      f.reproduction.actual = verdict.actual;
      f.likely_cause = verdict.likely_cause;
      f.fix_hint = verdict.fix_hint;
      if (!f.description || f.description.length < 30) f.description = verdict.description;
      f.confidence_breakdown.notes.push(`reviewer: ${verdict.is_defect ? 'defect' : 'NOT a defect'} — ${verdict.reasoning.slice(0, 300)}`);
      // Other defects the reviewer saw on screen become new candidates (replayed from this finding's steps); they never affect this finding.
      for (const n of o.nearby ? (verdict.nearby_defects ?? []) : []) {
        const parsed = RawFinding.safeParse({
          session: `reviewer:${id}`,
          persona: null,
          type: n.type,
          title: n.title,
          description: n.description,
          severity: n.severity,
          confidence: n.confidence,
          hypothesis: `seen by the triage reviewer in the viewport screenshot of ${id}`,
          strategy: null,
          page: rep.page,
          url: rep.url,
          environment: { browser: rep.environment.browser, viewport: env.viewport, variant: { ...rep.environment.variant, ...env.variant } },
          element: { selector: n.selector || null, text: null, bbox: null, signature: null },
          detector: null,
          trace: minimal,
          screenshot: shots.annotated,
          at: new Date().toISOString(),
        });
        if (parsed.success) o.nearby?.push(parsed.data);
      }
    } else f.confidence_breakdown.notes.push('reviewer unavailable');
  }
  if (!f.reproduction.expected) f.reproduction.expected = 'The element renders fully inside its container without overlapping or crowding other content.';
  if (!f.reproduction.actual) f.reproduction.actual = String(metrics.message ?? f.description).slice(0, 300);

  // 5. Screenshot or video?
  const temporal = TEMPORAL_TYPES.has(f.type) || rep.temporal_signals.some((s) => s.startsWith('layout-shift')) || (rep.temporal_signals.length > 0 && !DETECTABLE.has(f.type)) || !!verdict?.needs_video;
  if (temporal) f.evidence_kind = 'temporal';
  if (temporal && o.video !== false) {
    const vOpts = { ...rOpts, pool: undefined, id, runDir: o.runDir, title: f.title, selector: spec.selector, relatedSelector: spec.relatedSelector };
    let v = await recordVideo(minimal, vOpts).catch((e) => (notes.push(`video failed: ${e}`), null));
    if (v && o.review !== false) {
      const check = await reviewVideo({ runDir: o.runDir, title: f.title, filmstrip: v.filmstrip, bugFrame: v.bugFrame, provider: o.config.provider, model: o.config.model, transcriptPath: join(tdir, `video-${id}.jsonl`) }).catch(() => null);
      if (check && !check.visible) {
        notes.push(`video re-recorded: ${check.note}`);
        videoRerecorded = true;
        v = (await recordVideo(minimal, { ...vOpts, params: { paceMs: check.paceMs ?? 1400, holdMs: check.holdMs ?? 3000, settleMs: check.settleMs ?? 3000, slowMo: 150 } }).catch(() => v)) ?? v;
      }
    }
    if (v) f.video = { ...rel(o.runDir, { mp4: v.mp4, gif: v.gif, webm: v.webm, filmstrip: v.filmstrip, trace: v.trace }), bug_at_ms: v.bug_at_ms, chapters: v.chapters };
  }

  // 6. Executable repro.
  f.reproduction.spec = relative(o.runDir, writeReproSpec(o.runDir, f, o.baseUrl));

  // 7. Score + status.
  score(f, o.calibration, verdict ? verdict.is_defect : null);
  const fp = o.memory.matchFp(f);
  if (fp) {
    f.status = 'suppressed';
    f.confidence_breakdown.notes.push(`matches false-positive pattern ${fp.id}: ${fp.reason}`);
  } else if (presence === 'absent') f.status = 'flaky';
  else if (f.confidence < o.config.confidenceThreshold) f.status = 'low_confidence';
  else f.status = 'new';
  o.stats.push({
    id,
    type: f.type,
    ms: Date.now() - startedAt,
    replays,
    minimize_tries: minimizeTries,
    steps_original: normalizeSteps(rep.trace).length,
    steps_minimal: minimal.length,
    presence,
    rate,
    video: !!f.video,
    video_rerecorded: videoRerecorded,
    reviewer: o.review === false ? 'skipped' : verdict ? (verdict.is_defect ? 'defect' : 'not_defect') : 'unavailable',
    status: f.status,
  });
  return f;
}

function rel<T extends Record<string, string | null>>(runDir: string, o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v ? relative(runDir, v) : null])) as T;
}

export async function groupFindings(findings: Finding[], o: { intel: CodeIntel | null; repo: string | null; provider?: 'claude' | 'codex' | null; model: string | null; useLlm: boolean; log?: (m: string) => void; runDir?: string; onMethod?: (m: 'llm' | 'structural' | 'skipped') => void }): Promise<RootCauseGroup[]> {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const groups: RootCauseGroup[] = [];
  const used = new Set<string>();
  let proposals: Awaited<ReturnType<typeof proposeRootCauses>> = null;
  if (o.useLlm && findings.length > 1) {
    for (let attempt = 1; attempt <= 2 && !proposals; attempt++) {
      proposals = await proposeRootCauses(findings, { repo: o.repo, intelSummary: summarizeIntel(o.intel), provider: o.provider, model: o.model, transcriptPath: o.runDir ? join(o.runDir, 'transcripts', 'triage', `grouping-${attempt}.jsonl`) : undefined }).catch((e) => {
        o.log?.(`root-cause grouping attempt ${attempt} failed: ${String(e).slice(0, 200)}`);
        return null;
      });
      if (!proposals) o.log?.(`root-cause grouping attempt ${attempt} returned no groups${attempt === 1 ? '; retrying' : '; falling back to structural grouping'}`);
    }
  }
  let n = 0;
  for (const p of proposals ?? []) {
    const members = p.finding_ids.filter((id) => byId.has(id) && !used.has(id));
    if (!members.length) continue;
    members.forEach((id) => used.add(id));
    groups.push({ id: `RC-${String(++n).padStart(3, '0')}`, summary: p.summary, component: p.component ?? null, css_rule: p.css_rule ?? null, files: p.files ?? [], fix_plan: p.fix_plan, confidence: Math.max(0, Math.min(1, p.confidence ?? 0.5)), status_rollup: {}, findings: members.map((id) => byId.get(id)!) });
  }
  o.onMethod?.(!o.useLlm || findings.length < 2 ? 'skipped' : proposals ? 'llm' : 'structural');
  // Fallback / leftovers: group by component signature leaf, else singleton.
  const rest = findings.filter((f) => !used.has(f.id));
  const bySig = new Map<string, Finding[]>();
  for (const f of rest) {
    // Conservative fallback: same type AND same full component signature (e.g. "div.plan-card > button.cta").
    const key = f.element.signature && f.element.signature.includes(' > ') ? `${f.type}|${f.element.signature}` : f.id;
    bySig.set(key, [...(bySig.get(key) ?? []), f]);
  }
  for (const [key, members] of bySig) {
    const f0 = members[0];
    groups.push({ id: `RC-${String(++n).padStart(3, '0')}`, summary: members.length > 1 ? `${f0.type} in ${key.split('|')[1]} (${members.length} places; grouped structurally, not LLM-verified)` : f0.title, component: f0.element.signature?.split(' > ').pop() ?? null, css_rule: null, files: [...new Set(members.flatMap((m) => m.source_hints.slice(0, 2).map((h) => h.file)))], fix_plan: f0.fix_hint, confidence: members.length > 1 ? 0.5 : 0.8, status_rollup: {}, findings: members });
  }
  for (const g of groups) {
    for (const f of g.findings) {
      f.root_cause_id = g.id;
      f.siblings = g.findings.filter((x) => x.id !== f.id).map((x) => x.id);
    }
  }
  // Most severe / confident groups first.
  const sev = { critical: 0, major: 1, minor: 2, cosmetic: 3 } as const;
  return groups.sort((a, b) => Math.min(...a.findings.map((f) => sev[f.severity])) - Math.min(...b.findings.map((f) => sev[f.severity])) || b.findings.length - a.findings.length);
}

export { readFindings };

/** Re-runs root-cause grouping on an already-triaged run (findings are kept as-is). */
export async function regroupRun(runDir: string, log: (m: string) => void, useLlm = true) {
  const info = readRun(runDir);
  const config = Config.parse(info.config);
  const ff = readFindings(runDir);
  if (!ff) throw new Error('No findings.json yet: run triage first.');
  const intel: CodeIntel | null = existsSync(join(runDir, 'code-intel.json')) ? JSON.parse(readFileSync(join(runDir, 'code-intel.json'), 'utf8')) : null;
  const groups = await groupFindings(allFindings(ff), { intel, repo: info.repo_path, provider: config.provider, model: config.model, useLlm, log });
  writeFindings(runDir, { run_id: ff.run_id, target: ff.target, generated_at: ff.generated_at, groups });
  writeReport(runDir);
  log(`Regrouped ${allFindings(ff).length} findings into ${groups.length} groups.`);
}
