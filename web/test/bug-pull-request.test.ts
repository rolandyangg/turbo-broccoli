import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BugPullRequest } from '../src/components/PrList.tsx';

vi.mock('../src/lib/api.ts', () => ({
  useApi: () => ({ data: { prs: [] }, error: null, reload: vi.fn() }),
}));

const render = (readyToPublish: boolean, branch: string | null = 'fix/navigation') => renderToStaticMarkup(createElement(BugPullRequest, {
  ws: 'workspace', run: 'run', id: 'BB-001', url: null, body: null,
  branch, readyToPublish, onUpdated: async () => {},
}));

describe('bug pull request entry point', () => {
  it('offers publishing in the main PR area when the fix is ready', () => {
    const html = render(true);
    expect(html).toContain('Pull request');
    expect(html).toContain('Ready to publish');
    expect(html).toContain('Open pull request</button>');
  });

  it('does not offer publishing before readiness or without a branch', () => {
    expect(render(false)).toBe('');
    expect(render(true, null)).toBe('');
  });
});
