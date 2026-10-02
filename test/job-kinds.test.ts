import { describe, expect, it } from 'vitest';
import { fixJobKind, isFixJob } from '../src/jobs/kinds.js';

describe('fix workflow job kinds', () => {
  it('classifies publishing an existing branch separately', () => {
    expect(fixJobKind({ mode: 'continue', pr: true })).toBe('publish');
    for (const mode of ['new', 'retry', 'verify', undefined]) {
      expect(fixJobKind({ mode, pr: true })).toBe('fix');
    }
    expect(fixJobKind({ mode: 'continue', pr: false })).toBe('fix');
  });

  it('keeps publishing in fix history and concurrency guards', () => {
    expect(isFixJob({ kind: 'publish' })).toBe(true);
    expect(isFixJob({ kind: 'fix' })).toBe(true);
    expect(isFixJob({ kind: 'explore' })).toBe(false);
  });
});
