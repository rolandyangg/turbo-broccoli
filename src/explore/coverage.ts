import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { STRATEGY_IDS } from './strategies.js';

export interface PageCoverage {
  states: string[]; // state keys (domHash)
  seen: Record<string, string>; // interactive selector -> text
  tried: string[]; // interactive selectors acted on
  widths: number[];
  variants: string[]; // e.g. "dark", "font2", "zoom2", "dpr2", "offline"
  browsers: string[];
  strategies: string[];
}

export type CoverageMap = Record<string, PageCoverage>;

const empty = (): PageCoverage => ({ states: [], seen: {}, tried: [], widths: [], variants: [], browsers: [], strategies: [] });

/** Normalizes URLs to a "page" key: pathname with numeric/uuid segments collapsed. */
export function pageKey(path: string): string {
  let p = path.split('#')[0].split('?')[0] || '/';
  p = p.replace(/\/index\.html?$/, '/').replace(/\.html?$/, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.replace(/\/[0-9]+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:uuid');
}

/** Per-session coverage, persisted to <runDir>/coverage/<session>.json so parallel sessions can see each other. */
export class Coverage {
  map: CoverageMap = {};
  private file: string;

  constructor(private runDir: string, session: string) {
    mkdirSync(join(runDir, 'coverage'), { recursive: true });
    this.file = join(runDir, 'coverage', `${session}.json`);
  }

  private page(path: string) {
    const k = pageKey(path);
    return (this.map[k] ??= empty());
  }
  private add<T>(arr: T[], v: T) {
    if (!arr.includes(v)) arr.push(v);
  }

  state(path: string, key: string) {
    const pc = this.page(path);
    const isNew = !pc.states.includes(key) && !mergeAll(this.runDir)[pageKey(path)]?.states.includes(key);
    this.add(pc.states, key);
    return isNew;
  }
  seen(path: string, items: { selector: string | null; text: string }[]) {
    const pc = this.page(path);
    for (const i of items) if (i.selector) pc.seen[i.selector] ??= i.text.slice(0, 60);
  }
  tried(path: string, selector: string) {
    this.add(this.page(path).tried, selector);
  }
  width(path: string, w: number) {
    this.add(this.page(path).widths, w);
  }
  variant(path: string, v: string) {
    this.add(this.page(path).variants, v);
  }
  browser(path: string, b: string) {
    this.add(this.page(path).browsers, b);
  }
  strategy(path: string, s: string) {
    this.add(this.page(path).strategies, s);
  }
  flush() {
    writeFileSync(this.file, JSON.stringify(this.map));
  }
}

export function mergeAll(runDir: string): CoverageMap {
  const dir = join(runDir, 'coverage');
  const out: CoverageMap = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    let m: CoverageMap;
    try {
      m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    for (const [k, pc] of Object.entries(m)) {
      const t = (out[k] ??= empty());
      for (const key of ['states', 'tried', 'widths', 'variants', 'browsers', 'strategies'] as const) {
        for (const v of pc[key] as (string | number)[]) if (!(t[key] as (string | number)[]).includes(v)) (t[key] as (string | number)[]).push(v);
      }
      Object.assign(t.seen, pc.seen);
    }
  }
  return out;
}

export function summarize(map: CoverageMap, allWidths: number[], browsers: string[]) {
  return Object.entries(map)
    .map(([page, pc]) => {
      const untried = Object.entries(pc.seen).filter(([s]) => !pc.tried.includes(s));
      return {
        page,
        states: pc.states.length,
        interactives_seen: Object.keys(pc.seen).length,
        interactives_tried: pc.tried.length,
        untried_examples: untried.slice(0, 12).map(([s, t]) => `${t || '(no text)'} → ${s}`),
        widths_tested: [...pc.widths].sort((a, b) => a - b),
        widths_untested: allWidths.filter((w) => !pc.widths.includes(w)),
        variants_tested: pc.variants,
        browsers_tested: pc.browsers,
        browsers_untested: browsers.filter((b) => !pc.browsers.includes(b)),
        strategies_untried: STRATEGY_IDS.filter((s) => !pc.strategies.includes(s)),
      };
    })
    .sort((a, b) => b.interactives_seen - b.interactives_tried - (a.interactives_seen - a.interactives_tried));
}
