import { describe, expect, it } from 'vitest';
import { groupImprovementBacklog } from '../src/lib/improvementBacklog.ts';

describe('improvement backlog', () => {
  it('counts only open items and archives merged and closed improvements', () => {
    const items = ['open', 'implementing', 'implemented', 'merged', 'failed', 'closed'].map((status) => ({ status }));
    const grouped = groupImprovementBacklog(items);
    expect(grouped.openCount).toBe(1);
    expect(grouped.backlog.map((item) => item.status)).toEqual(['open', 'implementing', 'implemented', 'failed']);
    expect(grouped.archive.map((item) => item.status)).toEqual(['merged', 'closed']);
  });

  it('moves an item out of the backlog after merging', () => {
    const item = { status: 'open' };
    expect(groupImprovementBacklog([item]).openCount).toBe(1);
    item.status = 'merged';
    expect(groupImprovementBacklog([item])).toEqual({ openCount: 0, backlog: [], archive: [item] });
  });
});
