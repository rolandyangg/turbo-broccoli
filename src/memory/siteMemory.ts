import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, FindingStatus } from '../store/schema.js';

/**
 * Durable, human-editable memory across runs, stored under <workspace>/memory/:
 *   site.json         routes/pages/components discovered, last commit scanned
 *   known_bugs.json   fingerprints and status history (drives new/recurring/regressed tagging)
 *   fp_patterns.json  false-positive patterns learned from user labels
 *   lessons.md        short notes written by the lead agent
 *   labels.jsonl      every user label (training data for calibration)
 */
export interface SiteModel {
  routes: string[];
  pages: Record<string, { lastSeenRun: string; findings: number }>;
  lastCommit: string | null;
  lastRun: string | null;
}

export interface KnownBug {
  fingerprint: string;
  last_id: string;
  title: string;
  type: string;
  page: string;
  status: FindingStatus;
  first_seen_run: string;
  last_seen_run: string;
  history: { run: string; status: FindingStatus; id: string }[];
}

export interface FpPattern {
  id: string;
  type: string | null;
  selector_contains: string | null;
  text_contains: string | null;
  page: string | null;
  reason: string;
  source_finding: string | null;
  created: string;
}

export interface Label {
  finding_id: string;
  run: string;
  fingerprint: string;
  type: string;
  label: 'confirmed' | 'false_positive';
  raw_confidence: number | null;
  note: string | null;
  at: string;
}

export class Memory {
  readonly dir: string;
  constructor(workspace: string) {
    this.dir = join(workspace, 'memory');
    mkdirSync(this.dir, { recursive: true });
  }

  private read<T>(name: string, fallback: T): T {
    const f = join(this.dir, name);
    if (!existsSync(f)) return fallback;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
  private write(name: string, v: unknown) {
    writeFileSync(join(this.dir, name), JSON.stringify(v, null, 2) + '\n');
  }

  site(): SiteModel {
    return this.read<SiteModel>('site.json', { routes: [], pages: {}, lastCommit: null, lastRun: null });
  }
  saveSite(s: SiteModel) {
    this.write('site.json', s);
  }

  knownBugs(): KnownBug[] {
    return this.read<KnownBug[]>('known_bugs.json', []);
  }
  saveKnownBugs(b: KnownBug[]) {
    this.write('known_bugs.json', b);
  }

  fpPatterns(): FpPattern[] {
    return this.read<FpPattern[]>('fp_patterns.json', []);
  }
  saveFpPatterns(p: FpPattern[]) {
    this.write('fp_patterns.json', p);
  }

  lessons(): string {
    const f = join(this.dir, 'lessons.md');
    return existsSync(f) ? readFileSync(f, 'utf8') : '';
  }
  appendLessons(runId: string, text: string) {
    appendFileSync(join(this.dir, 'lessons.md'), `\n## ${runId}\n${text.trim()}\n`);
  }

  labels(): Label[] {
    const f = join(this.dir, 'labels.jsonl');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Label);
  }
  addLabel(l: Label) {
    appendFileSync(join(this.dir, 'labels.jsonl'), JSON.stringify(l) + '\n');
  }

  /** Returns the matching false-positive pattern, if any. */
  matchFp(f: Pick<Finding, 'type' | 'page'> & { element: { selector: string | null; text: string | null } }): FpPattern | null {
    for (const p of this.fpPatterns()) {
      if (p.type && p.type !== f.type) continue;
      if (p.page && p.page !== f.page) continue;
      if (p.selector_contains && !(f.element.selector ?? '').includes(p.selector_contains)) continue;
      if (p.text_contains && !(f.element.text ?? '').toLowerCase().includes(p.text_contains.toLowerCase())) continue;
      return p;
    }
    return null;
  }

  /** Classifies a finding against history and updates the known-bug record. */
  track(runId: string, f: Finding): 'new' | 'recurring' | 'regressed' {
    const bugs = this.knownBugs();
    const kb = bugs.find((b) => b.fingerprint === f.fingerprint);
    let tag: 'new' | 'recurring' | 'regressed' = 'new';
    if (kb) {
      tag = kb.status === 'fixed' ? 'regressed' : 'recurring';
      kb.last_id = f.id;
      kb.last_seen_run = runId;
      kb.title = f.title;
      if (kb.status === 'fixed') kb.status = 'new';
      kb.history.push({ run: runId, status: f.status, id: f.id });
    } else {
      bugs.push({ fingerprint: f.fingerprint, last_id: f.id, title: f.title, type: f.type, page: f.page, status: f.status, first_seen_run: runId, last_seen_run: runId, history: [{ run: runId, status: f.status, id: f.id }] });
    }
    this.saveKnownBugs(bugs);
    return tag;
  }

  setBugStatus(fingerprint: string, status: FindingStatus, runId: string, id: string) {
    const bugs = this.knownBugs();
    const kb = bugs.find((b) => b.fingerprint === fingerprint);
    if (!kb) return;
    kb.status = status;
    kb.history.push({ run: runId, status, id });
    this.saveKnownBugs(bugs);
  }

  summary(): string {
    const site = this.site();
    const bugs = this.knownBugs();
    const open = bugs.filter((b) => !['fixed', 'false_positive', 'suppressed'].includes(b.status));
    const fixed = bugs.filter((b) => b.status === 'fixed');
    const fps = this.fpPatterns();
    return [
      `Last run: ${site.lastRun ?? 'none'}; known routes: ${site.routes.join(', ') || 'none'}`,
      `Open known bugs to re-check (${open.length}):`,
      ...open.slice(0, 25).map((b) => `  - [${b.last_id}] ${b.page}: ${b.title} (${b.type})`),
      `Fixed bugs to regression-check (${fixed.length}):`,
      ...fixed.slice(0, 15).map((b) => `  - [${b.last_id}] ${b.page}: ${b.title}`),
      `False-positive patterns (${fps.length}):`,
      ...fps.map((p) => `  - ${p.type ?? 'any'} ${p.selector_contains ? `selector~"${p.selector_contains}"` : ''} ${p.text_contains ? `text~"${p.text_contains}"` : ''} ${p.page ?? ''}: ${p.reason}`),
      `Lessons:\n${this.lessons().slice(-3000) || '  (none yet)'}`,
    ].join('\n');
  }
}
