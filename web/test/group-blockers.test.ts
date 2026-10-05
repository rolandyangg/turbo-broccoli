import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { Finding } from '../../src/store/schema.ts';
import { groupFixBlockers } from '../../src/fix/groupBlockers.ts';
import { FixVerification } from '../src/components/FixVerification.tsx';
function finding(id: string, result: 'fixed' | 'present' | 'inconclusive', branch = 'bugbash/group') {
  return Finding.parse({ id, title: `Title ${id}`, fingerprint: id, type: 'other', confidence: .88, page: '/',
    reproduction: { environment: { browser: 'webkit', viewport: { width: 768, height: 1024 }, variant: {} } },
    fix: { branch, at: 'now', pr_url: null, verified: false, blocked: true, verification: { result, method: 'visual-review', at: 'now', review: { fixed: true, confidence: .88, reasoning: 'gone' } } } });
}
describe('group fix blockers', () => {
  it('lists unresolved findings on the same branch and excludes the current bug, fixed bugs, and unrelated branches', () => {
    const current = finding('BB-0105', 'fixed');
    expect(groupFixBlockers(current, [current, finding('BB-0096', 'inconclusive'), finding('BB-0112', 'present'), finding('BB-0106', 'fixed'), finding('BB-0001', 'present', 'bugbash/other')])).toEqual([
      { id: 'BB-0096', title: 'Title BB-0096', reasons: ['Fix could not be confirmed'] },
      { id: 'BB-0112', title: 'Title BB-0112', reasons: ['Bug is still present'] },
    ]);
  });
  it('shows clickable blockers while explaining that this bug passed its confidence threshold', () => {
    const f = finding('BB-0105', 'fixed');
    const blockers = groupFixBlockers(f, [f, finding('BB-0096', 'inconclusive')]);
    const html = renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(FixVerification, { f, groupBlockers: blockers, ws: 'workspace', run: 'run', branch: f.fix!.branch, afterShot: null, running: false, prUrl: null, reproducing: false, onReproduceStarted: () => {} })));
    expect(html).toContain('group fix blocked');
    expect(html).toContain('BB-0105 passed its check');
    expect(html).toContain('88% confidence; threshold 60%');
    expect(html).toContain('href="/runs/workspace/run/bugs/BB-0096"');
    expect(html).toContain('Fix could not be confirmed');
  });
});
