import { expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTarget } from '../src/target/resolve.js';
import { BrowserPool } from '../src/triage/replay.js';
import { Config } from '../src/config.js';
import { pageSnapshot } from '../src/fix/verify.js';
import { annotateDefect } from '../src/triage/annotate.js';

it('captures a candidate close-up before the snapshot browser closes', async () => {
  const target = await resolveTarget('fixtures/buggy-site');
  const pool = new BrowserPool();
  const dir = mkdtempSync(join(tmpdir(), 'regression-evidence-'));
  let captured = false;
  try {
    const snapshot = await pageSnapshot('/', { baseUrl: target.baseUrl, guardrails: Config.parse({}).guardrails, pool, widths: [700],
      onCandidate: async (key, candidate, page) => {
        if (captured || candidate.type !== 'overlap') return;
        expect(key).toContain('700|overlap|');
        await annotateDefect(page, { selector: candidate.selector, relatedSelector: candidate.related?.selector,
          fallbackBBox: candidate.bbox, label: candidate.message,
          files: { annotated: join(dir, 'annotated.png'), crop: join(dir, 'crop.png'), full: join(dir, 'full.png') } });
        captured = true;
      },
    });
    expect(snapshot.size).toBeGreaterThan(0);
    expect(captured).toBe(true);
    expect(existsSync(join(dir, 'crop.png'))).toBe(true);
  } finally {
    await pool.close();
    await target.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
