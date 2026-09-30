import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFindings, allFindings, readRun } from './store/store.js';
import type { Finding } from './store/schema.js';
import { Memory } from './memory/siteMemory.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

interface SeededBug {
  id: string;
  page: string;
  types: string[];
  match: string[];
  browsers: string[];
  kind: string;
  also_pages?: string[];
  browser_specific?: boolean;
  shared_component?: string;
}
interface Manifest {
  bugs: SeededBug[];
  controls: { page: string; match: string[]; note: string }[];
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(join(root, 'bench', 'manifest.json'), 'utf8'));
}

const hay = (f: Finding) => `${f.element.selector ?? ''} ${f.element.text ?? ''} ${f.title} ${JSON.stringify((f.metrics as any)?.related ?? '')}`.toLowerCase();

export function matchesBug(f: Finding, b: SeededBug) {
  const pages = [b.page, ...(b.also_pages ?? [])];
  return pages.includes(f.page) && b.types.includes(f.type) && b.match.some((m) => hay(f).includes(m.toLowerCase()));
}

/** Scores a triaged run against the seeded-bug manifest and records labels for calibration. */
export function scoreRun(runDir: string, opts: { label?: boolean } = {}) {
  const man = loadManifest();
  const info = readRun(runDir);
  const ff = readFindings(runDir);
  if (!ff) throw new Error('Run has no findings.json (triage first).');
  const findings = allFindings(ff);
  const active = findings.filter((f) => ['new', 'confirmed', 'fixing', 'fixed'].includes(f.status));
  const perBug = man.bugs.map((b) => {
    const hits = findings.filter((f) => matchesBug(f, b));
    const activeHits = hits.filter((f) => active.includes(f));
    return {
      id: b.id,
      kind: b.kind,
      found: activeHits.length > 0,
      found_any_status: hits.length > 0,
      browsers_ok: b.browser_specific ? activeHits.every((f) => f.browsers.every((x) => b.browsers.includes(x))) && activeHits.length > 0 : null,
      instances: activeHits.length,
      findings: hits.map((f) => `${f.id}(${f.status})`),
    };
  });
  const controlsHit = man.controls.map((c) => ({
    note: c.note,
    flagged_active: active.filter((f) => f.page === c.page && c.match.some((m) => hay(f).includes(m.toLowerCase()))).map((f) => f.id),
  }));
  const matched = new Set(findings.filter((f) => man.bugs.some((b) => matchesBug(f, b))).map((f) => f.id));
  const unmatchedActive = active.filter((f) => !matched.has(f.id));
  const found = perBug.filter((b) => b.found).length;
  const byKind = (k: string) => {
    const xs = perBug.filter((b) => b.kind === k);
    return xs.length ? `${xs.filter((b) => b.found).length}/${xs.length}` : 'n/a';
  };
  const result = {
    run: info.run_id,
    mode: info.stages.explore?.note ?? '',
    recall: Math.round((found / man.bugs.length) * 100) / 100,
    recall_by_kind: { static: byKind('static'), interaction: byKind('interaction'), temporal: byKind('temporal') },
    precision_vs_manifest: active.length ? Math.round((active.filter((f) => matched.has(f.id)).length / active.length) * 100) / 100 : null,
    active_findings: active.length,
    unmatched_active: unmatchedActive.map((f) => `${f.id} ${f.type} ${f.page}: ${f.title}`),
    per_bug: perBug,
    controls: controlsHit,
    sessions: (info.jobs as unknown[]).length,
    stop_reason: info.stop_reason,
  };
  if (opts.label) {
    const memory = new Memory(info.workspace);
    for (const f of findings) {
      const isBug = matched.has(f.id);
      const isControl = man.controls.some((c) => f.page === c.page && c.match.some((m) => hay(f).includes(m.toLowerCase())));
      if (!isBug && !isControl) continue; // unseeded: could be real, don't label
      memory.addLabel({ finding_id: f.id, run: info.run_id, fingerprint: f.fingerprint, type: f.type, label: isBug ? 'confirmed' : 'false_positive', raw_confidence: f.confidence_breakdown.raw, note: 'bench', at: new Date().toISOString() });
    }
  }
  const outDir = join(root, 'bench', 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${info.run_id}.json`), JSON.stringify(result, null, 2));
  return result;
}
