import type { RawFinding, Viewport, BrowserName } from '../store/schema.js';

export interface Cluster {
  fingerprint: string;
  type: string;
  page: string;
  members: RawFinding[];
  representative: RawFinding;
  viewports: Viewport[];
  browsers: BrowserName[];
  relatedSelector: string | null;
  /** The same defect on other pages (second-pass merge); never counted as a new unique finding. */
  alsoSeen: { page: string; sessions: string[]; viewports: string[] }[];
}

/** Strip positional noise so the same element across runs/sessions gets the same key. */
export function normalizeSelector(sel: string | null): string {
  if (!sel) return '';
  return sel
    .replace(/:nth-of-type\((\d+)\)/g, ':n$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const TYPE_FAMILY: Record<string, string> = { 'spill-out': 'overflow', 'text-overflow': 'overflow', 'too-close': 'spacing', 'small-tap-target': 'spacing' };

export function fingerprintOf(f: RawFinding): string {
  const related = (f.detector?.metrics?.related as { selector?: string } | null)?.selector ?? null;
  const sels = [normalizeSelector(f.element.selector), normalizeSelector(related)].filter(Boolean).sort();
  const family = TYPE_FAMILY[f.type] ?? f.type;
  if (f.type === 'layout-shift') return `layout-shift|${f.page}`;
  if (!sels.length) return `${family}|${f.page}|${f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60)}`;
  // Overlaps are symmetric: key on the pair.
  return `${family}|${f.type === 'overlap' ? sels.join('<>') : sels[0]}|${f.page}`;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2, cosmetic: 3 };

/** Root-cause key for the second pass: same type family + same component (or text signature), regardless of page. */
function rootCauseKey(f: RawFinding): string | null {
  if (f.type === 'layout-shift') return null;
  const related = (f.detector?.metrics?.related as { selector?: string } | null)?.selector ?? null;
  const sels = [normalizeSelector(f.element.selector), normalizeSelector(related)].filter(Boolean).sort();
  const family = TYPE_FAMILY[f.type] ?? f.type;
  if (sels.length) return `${family}|${f.type === 'overlap' ? sels.join('<>') : sels[0]}`;
  const text = f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
  return text ? `${family}|text:${text}` : null;
}

export function clusterFindings(raw: RawFinding[]): Cluster[] {
  const map = new Map<string, RawFinding[]>();
  for (const f of raw) {
    const fp = fingerprintOf(f);
    map.set(fp, [...(map.get(fp) ?? []), f]);
  }
  // Second pass: the same defect seen on other pages/sessions/viewports is one finding, not a new one.
  const merged = new Map<string, { members: RawFinding[]; pages: Map<string, RawFinding[]> }>();
  for (const [fp, members] of map) {
    const key = rootCauseKey(members[0]) ?? fp;
    const g = merged.get(key) ?? { members: [], pages: new Map<string, RawFinding[]>() };
    g.members.push(...members);
    g.pages.set(members[0].page, [...(g.pages.get(members[0].page) ?? []), ...members]);
    merged.set(key, g);
  }
  const clusters: Cluster[] = [];
  for (const { members, pages } of merged.values()) {
    // Representative: highest severity, then detector evidence, then confidence, then shorter trace.
    const rep = [...members].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Number(!!b.detector) - Number(!!a.detector) || b.confidence - a.confidence || a.trace.length - b.trace.length)[0];
    const alsoSeen = [...pages].filter(([page]) => page !== rep.page).map(([page, ms]) => ({ page, sessions: [...new Set(ms.map((m) => m.session))], viewports: [...new Set(ms.map((m) => `${m.environment.viewport.width}x${m.environment.viewport.height}`))] }));
    const vps = new Map<string, Viewport>();
    const browsers = new Set<BrowserName>();
    for (const m of members) {
      vps.set(`${m.environment.viewport.width}x${m.environment.viewport.height}`, m.environment.viewport);
      browsers.add(m.environment.browser);
      // Detector sweeps tell us the widths where the candidate occurred.
      const widths = m.detector?.metrics?.widths as number[] | undefined;
      for (const w of widths ?? []) vps.set(`${w}x${m.environment.viewport.height}`, { width: w, height: m.environment.viewport.height });
    }
    clusters.push({
      fingerprint: fingerprintOf(rep),
      alsoSeen,
      type: rep.type,
      page: rep.page,
      members,
      representative: rep,
      viewports: [...vps.values()].sort((a, b) => a.width - b.width),
      browsers: [...browsers],
      relatedSelector: (rep.detector?.metrics?.related as { selector?: string } | null)?.selector ?? null,
    });
  }
  return clusters.sort((a, b) => b.representative.confidence - a.representative.confidence);
}
