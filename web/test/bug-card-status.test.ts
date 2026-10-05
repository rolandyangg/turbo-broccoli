import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { BugCard } from '../src/components/BugCard.tsx';
import type { BugPr, BugFixJob } from '../src/lib/bugFixStatus.ts';
import type { Finding } from '../src/lib/types.ts';

const finding = {
  id: 'BB-001', status: 'fixing', title: 'Navigation overlaps content', page: '/', browsers: ['chromium'],
  viewports: [{ width: 375, height: 812 }], severity: 'major', type: 'overlap', confidence: 0.9,
  history_tag: 'new', reproduction: { rate: null }, screenshots: { crop: null, annotated: null },
  fix: { pr_url: 'https://github.com/example/repo/pull/12' },
} as Finding;
const render = (f: Finding, prs: readonly BugPr[] = [], jobs: readonly BugFixJob[] = []) => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(BugCard, { f, ws: 'ws', run: 'run', prs, jobs })));

describe('bug card fix ribbon', () => {
  it('shows a noticeable label and PR number even without a screenshot', () => {
    const html = render(finding);
    expect(html).toContain('bug-fix-raised');
    expect(html).toContain('bug-fix-preview');
    expect(html).toContain('PR raised');
    expect(html).toContain('#12');
    expect(html).toContain('href="https://github.com/example/repo/pull/12"');
    expect(html).toContain('aria-label="Open pull request #12"');
    expect(html).toContain('/runs/ws/run/bugs/BB-001');
  });
  it('overlays the preview while keeping the video badge', () => {
    const html = render({ ...finding, screenshots: { ...finding.screenshots, crop: 'shot.png' }, video: {} as Finding['video'] });
    expect(html).toContain('class="thumb"');
    expect(html).toContain('bug-fix-ribbon');
    expect(html).toContain('thumb-badge');
  });
  it('shows the grey draft state on the thumbnail', () => {
    const html = render({ ...finding, screenshots: { ...finding.screenshots, crop: 'shot.png' } }, [{
      url: finding.fix!.pr_url!, number: 12, bugs: [{ id: finding.id }],
      status: { state: 'OPEN', isDraft: true },
    }]);
    expect(html).toContain('bug-fix-draft');
    expect(html).toContain('<strong>Drafted PR</strong>');
    expect(html).toContain('bug-fix-ribbon');
    expect(html).toContain('#12');
  });
  it('shows the purple merged state on the thumbnail', () => {
    const html = render({ ...finding, screenshots: { ...finding.screenshots, crop: 'shot.png' } }, [{
      url: finding.fix!.pr_url!, number: 12, bugs: [{ id: finding.id }],
      status: { state: 'MERGED', isDraft: false },
    }]);
    expect(html).toContain('bug-fix-merged');
    expect(html).toContain('<strong>Merged</strong>');
    expect(html).toContain('bug-fix-ribbon');
    expect(html).toContain('#12');
  });
  it('shows the yellow review state for a verified fix', () => {
    const html = render({ ...finding, screenshots: { ...finding.screenshots, crop: 'shot.png' }, fix: {
      branch: 'fix/bug', verified: true,
      verification: { result: 'fixed' } as NonNullable<Finding['fix']>['verification'],
    } as Finding['fix'] });
    expect(html).toContain('bug-fix-review');
    expect(html).toContain('<strong>Ready for Review</strong>');
    expect(html).toContain('bug-fix-ribbon');
  });
  it('shows a red verification overlay for a completed unverified fix', () => {
    const html = render({ ...finding, screenshots: { ...finding.screenshots, crop: 'shot.png' },
      fix: { branch: 'fix/bug', job_id: 'fix-1', verified: false } as Finding['fix'],
    }, [], [{ id: 'fix-1', state: 'succeeded' }]);
    expect(html).toContain('bug-fix-unverified');
    expect(html).toContain('<strong>Needs Verification</strong>');
    expect(html).toContain('bug-fix-ribbon');
  });
  it('shows a blue overlay for a running fix before a fix record exists', () => {
    const html = render({ ...finding, fix: null, screenshots: { ...finding.screenshots, crop: 'shot.png' } }, [],
      [{ id: 'new-fix', state: 'running', kind: 'fix', finding_ids: [finding.id] }]);
    expect(html).toContain('bug-fix-fixing');
    expect(html).toContain('<strong>Being Fixed</strong>');
    expect(html).toContain('bug-fix-ribbon');
  });
  it('leaves bugs without fixes without a ribbon', () => {
    expect(render({ ...finding, fix: null })).not.toContain('bug-fix-ribbon');
  });
});
