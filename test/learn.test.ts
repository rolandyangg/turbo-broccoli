import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProposals, decide, backlog, priors, rejected, readImprovements, fingerprintOf, priorsText } from '../src/learn/proposals.js';
import { benchHistory } from '../src/bench.js';
import { RETRO_SCHEMA } from '../src/learn/retro.js';

const RUN = '2026-02-01T00-00-00Z';
const ws = () => mkdtempSync(join(tmpdir(), 'bb-learn-'));

describe('improvement proposals', () => {
  it('stores proposals as pending and applies nothing until approved', () => {
    const w = ws();
    const { added } = addProposals(w, RUN, 'retro', [{ kind: 'lesson', title: 'Open the pricing modal before sweeping phones', body: 'BUG-07 only shows with the modal open.' }]);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ status: 'pending', source: 'retro', id: expect.stringMatching(/^P-/) });
    expect(existsSync(join(w, 'memory', 'lessons.md'))).toBe(false);
  });

  it('approve: lessons go to memory, priors to priors.json, detector and tweak items to the backlog', () => {
    const w = ws();
    const { added } = addProposals(w, RUN, 'retro', [
      { kind: 'lesson', title: 'Pricing modal needs Compare clicked', body: 'Seen in s-002.' },
      { kind: 'prior', title: 'Prefer font-scale on pricing', body: '11 uses → 6 surviving bugs', prior: { strategy: 'content.font-scale', persona: null, page_kind: 'pricing', effect: 'prefer' } },
      { kind: 'detector', title: 'Detect dropdown hover gaps', body: '3 reports, no detector', detector: { finding_type: 'broken-state', sketch: 'measure gap between trigger and menu' } },
      { kind: 'tweak', title: 'Show known findings in the explorer brief', body: '33% duplicates', tweak: { target: 'explorer-prompt', change: 'list known bugs' } },
    ]);
    const r = added.map((p) => decide(w, RUN, p.id, { action: 'approve' }));
    expect(r.every((x) => x.proposal.status === 'approved')).toBe(true);
    expect(readFileSync(join(w, 'memory', 'lessons.md'), 'utf8')).toMatch(/Pricing modal needs Compare clicked/);
    expect(priors(w)).toHaveLength(1);
    expect(priorsText(w)).toMatch(/Prefer content.font-scale on pricing pages/);
    expect(backlog(w).map((b) => [b.id, b.kind, b.status])).toEqual([
      ['B-1', 'detector', 'open'],
      ['B-2', 'tweak', 'open'],
    ]);
    expect(() => decide(w, RUN, added[0].id, { action: 'reject' })).toThrow(/already approved/);
  });

  it('edit before approving keeps the edited text and marks it edited', () => {
    const w = ws();
    const [p] = addProposals(w, RUN, 'lead', [{ kind: 'lesson', title: 'Slow page', body: 'x' }]).added;
    decide(w, RUN, p.id, { action: 'approve', body: 'The /account page needs 3s to settle after login.' });
    const saved = readImprovements(w, RUN).proposals[0];
    expect(saved.edited).toBe(true);
    expect(readFileSync(join(w, 'memory', 'lessons.md'), 'utf8')).toMatch(/needs 3s to settle/);
  });

  it('remembers rejections and never re-proposes them (or duplicates of pending/approved ones)', () => {
    const w = ws();
    const [p] = addProposals(w, RUN, 'retro', [{ kind: 'tweak', title: 'Raise the tool budget to 120 calls', body: 'x', tweak: { target: 'config', change: 'maxToolCallsPerSession 120' } }]).added;
    decide(w, RUN, p.id, { action: 'reject', note: 'too costly' });
    expect(rejected(w)[0]).toMatchObject({ fingerprint: p.fingerprint, note: 'too costly' });
    const again = addProposals(w, '2026-03-01T00-00-00Z', 'retro', [
      { kind: 'tweak', title: 'Raise the tool budget to 120 calls!', body: 'y', tweak: { target: 'config', change: 'same' } },
      { kind: 'lesson', title: 'New idea', body: 'z' },
    ]);
    expect(again.added.map((x) => x.title)).toEqual(['New idea']);
    expect(again.skipped).toEqual([{ title: 'Raise the tool budget to 120 calls!', reason: 'rejected before' }]);
    expect(addProposals(w, '2026-04-01T00-00-00Z', 'retro', [{ kind: 'lesson', title: 'new idea', body: 'dup' }]).skipped[0].reason).toBe('already pending');
  });

  it('fingerprints ignore word order and punctuation; priors key on strategy and effect', () => {
    expect(fingerprintOf({ kind: 'lesson', title: 'Check modals on phones', body: '' })).toBe(fingerprintOf({ kind: 'lesson', title: 'phones: check modals', body: 'other' }));
    const pr = (effect: 'prefer' | 'avoid') => fingerprintOf({ kind: 'prior', title: 'a', body: '', prior: { strategy: 'size.sweep', persona: null, page_kind: null, effect } });
    expect(pr('prefer')).not.toBe(pr('avoid'));
  });

  it('the retro output schema only allows known kinds and strategies', () => {
    const item = RETRO_SCHEMA.properties.proposals.items;
    expect(item.properties.kind.enum).toEqual(['lesson', 'prior', 'detector', 'tweak']);
    expect(item.properties.prior.properties.strategy.enum).toContain('chaos.keyboard');
  });
});

describe('benchmark gate', () => {
  it('groups results by agent version and flags a version that lost a seeded bug', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bb-bench-'));
    mkdirSync(dir, { recursive: true });
    const r = (run: string, version: string, recall: number) => writeFileSync(join(dir, `${run}.json`), JSON.stringify({ run, recall, precision_vs_manifest: 0.8, agent_version: version, agent_commit: version.slice(0, 7) }));
    r('2026-01-01T00-00-00Z', 'aaaa', 1);
    r('2026-01-02T00-00-00Z', 'aaaa', 0.91);
    r('2026-01-03T00-00-00Z', 'bbbb', 0.82);
    const h = benchHistory(dir);
    expect(h.map((v) => [v.version, v.best_recall, v.mean_recall])).toEqual([
      ['aaaa', 1, 0.96],
      ['bbbb', 0.82, 0.82],
    ]);
    expect(h[0].regression).toBeNull();
    expect(h[1].regression).toEqual({ from: 'aaaa', drop: 0.18 });
  });
});
