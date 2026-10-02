import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { BugCard } from '../src/components/BugCard.tsx';
import type { Finding } from '../src/lib/types.ts';

const finding = {
  id: 'BB-001', status: 'fixing', title: 'Navigation overlaps content', page: '/', browsers: ['chromium'],
  viewports: [{ width: 375, height: 812 }], severity: 'major', type: 'overlap', confidence: 0.9,
  history_tag: 'new', reproduction: { rate: null }, screenshots: { crop: null, annotated: null },
  fix: { pr_url: 'https://github.com/example/repo/pull/12' },
} as Finding;
const render = (f: Finding) => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(BugCard, { f, ws: 'ws', run: 'run' })));

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
  it('leaves bugs without fixes without a ribbon', () => {
    expect(render({ ...finding, fix: null })).not.toContain('bug-fix-ribbon');
  });
});
