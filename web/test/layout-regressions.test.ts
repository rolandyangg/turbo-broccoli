import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseRegression, regressionTitle } from '../../src/fix/regressions.ts';
import { Finding } from '../../src/store/schema.ts';
import { FixVerification } from '../src/components/FixVerification.tsx';

const legacy = '/home @1280px: new overlap on p.slide-project-description — A control is drawn on top of other content, hiding part of it.';
describe('layout regression details', () => {
  it('preserves the page, width, selector and explanation from older job logs', () => {
    const r = parseRegression(legacy)!;
    expect(r).toMatchObject({ page: '/home', width: 1280, selector: 'p.slide-project-description', preview: null });
    expect(regressionTitle(r)).toBe('Project description: covered by control');
    expect(parseRegression('unrelated log message')).toBeNull();
  });
  it('renders a separate disclosure and candidate-specific preview for each problem', () => {
    const f = Finding.parse({ id: 'BB-0094', fingerprint: 'test', type: 'other', title: 'Mirrored text', page: '/', confidence: .9, reproduction: { environment: { browser: 'chromium', viewport: { width: 1280, height: 800 }, variant: {} } } });
    const first = { ...parseRegression(legacy)!, preview: 'fixes/regression-1-crop.png' };
    const second = parseRegression('/ @1280px: new low-contrast on div.carouselCaption — Text contrast 1.03:1 is below 4.5:1.')!;
    const html = renderToStaticMarkup(createElement(FixVerification, {
      f, ws: 'ws', run: 'run', branch: 'fix', afterShot: null, running: false, prUrl: null,
      reproducing: false, onReproduceStarted: () => {}, regressions: [first, second],
    }));
    expect(html.match(/<details /g)).toHaveLength(2);
    expect(html).toContain('Project description: covered by control');
    expect(html).toContain('Gallery caption: low contrast');
    expect(html).toContain('regression-1-crop.png');
    expect(html).toContain('No preview saved for this check');
    expect(html).toContain('not yet confirmed as a regression');
  });
});
