import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import postcss, { type Root } from 'postcss';
import { execaSync } from 'execa';

export interface RiskyRule {
  file: string;
  line: number | null;
  selector: string;
  media: string | null;
  issue: string;
  decl: string;
  maxWidth: number | null; // media max-width in px, when inside a width-bounded media query
  minWidth: number | null;
}

export interface CodeIntel {
  repo: string;
  framework: string | null;
  breakpoints: number[];
  risky: RiskyRule[];
  components: { name: string; file: string; usages: number; usedIn: string[] }[];
  routes: string[];
  longStrings: { text: string; file: string }[];
  changedFiles: string[];
  headCommit: string | null;
  hypotheses: { text: string; widths: number[]; selector: string | null; source: string }[];
}

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.bugbash', 'coverage', '.turbo', '.svelte-kit', '.nuxt', 'vendor']);
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.pcss']);
const MARKUP_EXT = new Set(['.html', '.htm', '.jsx', '.tsx', '.vue', '.svelte', '.astro', '.js', '.ts']);

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 5000) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (IGNORE.has(e) || e.startsWith('.')) continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (st.size < 1_500_000) out.push(p);
  }
  return out;
}

function toPx(v: string): number | null {
  const m = v.match(/(-?\d*\.?\d+)\s*(px|em|rem)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'em' || m[2] === 'rem' ? n * 16 : n;
}

function mediaBounds(params: string) {
  const max = params.match(/max-width\s*:\s*([\d.]+(?:px|em|rem)?)/);
  const min = params.match(/min-width\s*:\s*([\d.]+(?:px|em|rem)?)/);
  const range = [...params.matchAll(/width\s*([<>]=?)\s*([\d.]+(?:px|em|rem)?)/g)];
  let maxWidth = max ? toPx(max[1]) : null;
  let minWidth = min ? toPx(min[1]) : null;
  for (const r of range) {
    if (r[1].startsWith('<')) maxWidth = toPx(r[2]);
    else minWidth = toPx(r[2]);
  }
  return { maxWidth, minWidth };
}

function extractStyles(file: string, src: string): { css: string; offsetLine: number }[] {
  const ext = extname(file);
  if (STYLE_EXT.has(ext)) return [{ css: src, offsetLine: 0 }];
  const blocks: { css: string; offsetLine: number }[] = [];
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    blocks.push({ css: m[1], offsetLine: src.slice(0, m.index).split('\n').length - 1 });
  }
  return blocks;
}

function analyzeCss(file: string, css: string, offsetLine: number, repo: string, bps: Set<number>, risky: RiskyRule[]) {
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch {
    // SCSS/LESS syntax postcss can't parse: fall back to media-query regex only.
    for (const m of css.matchAll(/@media[^{]*\(\s*(?:max|min)-width\s*:\s*([\d.]+(?:px|em|rem)?)/g)) {
      const px = toPx(m[1]);
      if (px) bps.add(Math.round(px));
    }
    return;
  }
  root.walkAtRules(/^(media|container)$/, (at) => {
    for (const m of at.params.matchAll(/([\d.]+)(px|em|rem)/g)) {
      const px = toPx(m[0]);
      if (px && px > 200 && px < 3000) bps.add(Math.round(px));
    }
  });
  root.walkRules((rule) => {
    if (rule.parent?.type === 'atrule' && /keyframes/.test((rule.parent as any).name)) return;
    const media = rule.parent?.type === 'atrule' && (rule.parent as any).name === 'media' ? (rule.parent as any).params : null;
    const bounds = media ? mediaBounds(media) : { maxWidth: null, minWidth: null };
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
    const isMedia = /\b(img|svg|video|canvas|icon|avatar|logo-img)\b/i.test(rule.selector);
    const push = (issue: string, decl: string) =>
      risky.push({ file: relative(repo, file), line: rule.source?.start?.line != null ? rule.source.start.line + offsetLine : null, selector: rule.selector.slice(0, 160), media, issue, decl, ...bounds });
    const fixedPx = (v?: string) => !!v && /^\d+(\.\d+)?(px|rem|em)$/.test(v.trim()) && (toPx(v) ?? 0) > 0;
    const hidesOverflow = /(hidden|clip)/.test(decls.overflow ?? '') || /(hidden|clip)/.test(decls['overflow-x'] ?? '') || /(hidden|clip)/.test(decls['overflow-y'] ?? '');
    if (!isMedia && fixedPx(decls.height) && !decls['min-height']) push(hidesOverflow ? 'fixed height + overflow hidden (text will clip)' : 'fixed height (text may overflow)', `height: ${decls.height}`);
    if (!isMedia && fixedPx(decls.width) && (decls['white-space'] === 'nowrap' || hidesOverflow)) push('fixed width with nowrap/overflow hidden', `width: ${decls.width}`);
    if (decls['white-space'] === 'nowrap' && !decls['text-overflow']) push('white-space: nowrap without ellipsis', 'white-space: nowrap');
    if (hidesOverflow && !decls['text-overflow'] && !isMedia) push('overflow hidden (may clip content)', `overflow: ${decls.overflow ?? decls['overflow-x'] ?? decls['overflow-y']}`);
    if (/100vw/.test(decls.width ?? '') || /100vw/.test(decls['min-width'] ?? '')) push('100vw width (horizontal scroll with scrollbars)', `width: ${decls.width ?? decls['min-width']}`);
    for (const p of ['margin', 'margin-left', 'margin-right']) if (/(^|\s)-\d/.test(decls[p] ?? '')) push('negative horizontal margin (overlap/cutoff risk)', `${p}: ${decls[p]}`);
    if (decls.position === 'absolute' && !isMedia && (decls.left || decls.right)) push('absolutely positioned (overlap risk)', `position: absolute; ${decls.left ? 'left: ' + decls.left : 'right: ' + decls.right}`);
    if (decls.position === 'fixed' || decls.position === 'sticky') push(`${decls.position} element (may cover content)`, `position: ${decls.position}`);
    const minW = toPx(decls['min-width'] ?? '');
    if (minW && minW > 320 && /px$/.test(decls['min-width'] ?? '')) push('min-width wider than small phones', `min-width: ${decls['min-width']}`);
    if (fixedPx(decls.width) && (toPx(decls.width) ?? 0) > 360 && !isMedia) push('fixed width wider than phones', `width: ${decls.width}`);
  });
}

const TAILWIND_BP: Record<string, number> = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 };

export function scanRepo(repo: string, sinceCommit: string | null = null): CodeIntel {
  const files = walk(repo);
  const bps = new Set<number>();
  const risky: RiskyRule[] = [];
  let framework: string | null = null;
  const pkgPath = join(repo, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  for (const f of ['next', 'nuxt', '@sveltejs/kit', 'astro', 'vite', 'react-scripts', '@angular/core', 'vue', 'react', 'svelte']) {
    if (deps[f]) {
      framework = f;
      break;
    }
  }
  const tailwind = !!deps.tailwindcss;
  if (tailwind) Object.values(TAILWIND_BP).forEach((b) => bps.add(b));

  const components: CodeIntel['components'] = [];
  const markupSources: { file: string; src: string }[] = [];
  const longStrings: CodeIntel['longStrings'] = [];

  for (const file of files) {
    const ext = extname(file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (STYLE_EXT.has(ext) || ext === '.html' || ext === '.vue' || ext === '.svelte' || ext === '.astro') {
      for (const b of extractStyles(file, src)) analyzeCss(file, b.css, b.offsetLine, repo, bps, risky);
    }
    if (MARKUP_EXT.has(ext)) {
      markupSources.push({ file, src });
      if (tailwind) {
        for (const m of src.matchAll(/\b(?:h|w|max-w)-\[(\d+px)\]/g)) risky.push({ file: relative(repo, file), line: src.slice(0, m.index).split('\n').length, selector: `(tailwind) ${m[0]}`, media: null, issue: 'arbitrary fixed size', decl: m[0], maxWidth: null, minWidth: null });
        for (const m of src.matchAll(/\bwhitespace-nowrap\b(?![^"']*\btruncate\b)/g)) risky.push({ file: relative(repo, file), line: src.slice(0, m.index).split('\n').length, selector: '(tailwind) whitespace-nowrap', media: null, issue: 'nowrap without truncate', decl: 'whitespace-nowrap', maxWidth: null, minWidth: null });
      }
      if (/\.(jsx|tsx|vue|svelte|astro)$/.test(file)) {
        const name = basename(file).replace(/\.(jsx|tsx|vue|svelte|astro)$/, '');
        if (/^[A-Z]/.test(name)) components.push({ name, file: relative(repo, file), usages: 0, usedIn: [] });
      }
    }
    if (ext === '.json' && /(locale|i18n|lang|translation|messages)/i.test(file)) {
      try {
        const flat: string[] = [];
        const visit = (v: unknown) => (typeof v === 'string' ? flat.push(v) : v && typeof v === 'object' && Object.values(v).forEach(visit));
        visit(JSON.parse(src));
        for (const s of flat) longStrings.push({ text: s, file: relative(repo, file) });
      } catch {}
    }
  }
  for (const c of components) {
    const re = new RegExp(`<${c.name}[\\s/>]`);
    for (const m of markupSources) {
      if (relative(repo, m.file) === c.file) continue;
      if (re.test(m.src)) {
        c.usages++;
        c.usedIn.push(relative(repo, m.file));
      }
    }
  }
  const shared = components.filter((c) => c.usages > 1).sort((a, b) => b.usages - a.usages);

  // Routes: Next.js app/pages dirs, SvelteKit routes, or static html files.
  const routes = new Set<string>();
  for (const f of files) {
    const rel = relative(repo, f);
    let m = rel.match(/^(?:src\/)?app\/(.*)page\.(tsx|jsx|ts|js|mdx)$/);
    if (m) routes.add('/' + m[1].replace(/\/$/, '').replace(/\([^)]*\)\/?/g, '').replace(/\[[^\]]+\]/g, ':param'));
    m = rel.match(/^(?:src\/)?pages\/(.*)\.(tsx|jsx|ts|js|vue|astro)$/);
    if (m && !/^(api\/|_)/.test(m[1])) routes.add('/' + m[1].replace(/(^|\/)index$/, '').replace(/\[[^\]]+\]/g, ':param'));
    m = rel.match(/^(?:src\/)?routes\/(.*)\+page\.svelte$/);
    if (m) routes.add('/' + m[1].replace(/\/$/, '').replace(/\[[^\]]+\]/g, ':param'));
    if (/\.html?$/.test(rel) && !rel.includes('/')) routes.add(rel === 'index.html' ? '/' : '/' + rel.replace(/\.html?$/, ''));
  }

  let headCommit: string | null = null;
  let changedFiles: string[] = [];
  try {
    headCommit = execaSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
    const diffs = new Set<string>();
    if (sinceCommit && sinceCommit !== headCommit) for (const l of execaSync('git', ['diff', '--name-only', `${sinceCommit}..HEAD`], { cwd: repo, reject: false }).stdout.split('\n')) if (l) diffs.add(l);
    for (const l of execaSync('git', ['status', '--porcelain'], { cwd: repo, reject: false }).stdout.split('\n')) if (l.trim()) diffs.add(l.slice(3));
    changedFiles = [...diffs].slice(0, 100);
  } catch {}

  const breakpoints = [...bps].sort((a, b) => a - b);
  const intel: CodeIntel = {
    repo,
    framework,
    breakpoints,
    risky: dedupeRisky(risky).slice(0, 200),
    components: shared.slice(0, 50),
    routes: [...routes].sort().slice(0, 200),
    longStrings: longStrings.sort((a, b) => b.text.length - a.text.length).slice(0, 25),
    changedFiles,
    headCommit,
    hypotheses: [],
  };
  intel.hypotheses = hypothesesFrom(intel);
  return intel;
}

function dedupeRisky(r: RiskyRule[]) {
  const seen = new Set<string>();
  return r.filter((x) => {
    const k = `${x.file}|${x.selector}|${x.issue}|${x.media}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const PRIORITY = ['fixed height + overflow hidden', 'fixed width with nowrap', 'negative horizontal margin', 'absolutely positioned', 'min-width wider', 'fixed width wider', '100vw', 'fixed height', 'white-space: nowrap', 'arbitrary fixed size', 'nowrap without truncate'];

function hypothesesFrom(ci: CodeIntel): CodeIntel['hypotheses'] {
  const out: CodeIntel['hypotheses'] = [];
  const ranked = [...ci.risky].sort((a, b) => rank(a.issue) - rank(b.issue));
  for (const r of ranked.slice(0, 30)) {
    const widths = r.maxWidth ? [Math.max(280, r.minWidth ?? 320), Math.round(r.maxWidth)] : r.minWidth ? [Math.round(r.minWidth), Math.round(r.minWidth) + 200] : [320, 1920];
    const where = r.media ? ` inside @media ${r.media}` : '';
    out.push({
      text: `\`${r.selector}\` has ${r.decl}${where} (${r.issue}; ${r.file}${r.line ? ':' + r.line : ''}). Test it with long text/labels, 200% font, and widths ${widths[0]}–${widths[1]}.`,
      widths,
      selector: r.selector.startsWith('(tailwind)') ? null : r.selector,
      source: `${r.file}${r.line ? ':' + r.line : ''}`,
    });
  }
  if (ci.breakpoints.length) out.push({ text: `CSS breakpoints: ${ci.breakpoints.join(', ')}px. Probe N-1/N/N+1 around each (layouts flip there).`, widths: ci.breakpoints, selector: null, source: 'media queries' });
  for (const c of ci.components.slice(0, 5)) out.push({ text: `Shared component ${c.name} (${c.file}) is used in ${c.usages} places (${c.usedIn.slice(0, 4).join(', ')}); a defect in it likely repeats — check all instances.`, widths: [], selector: null, source: c.file });
  if (ci.changedFiles.length) out.push({ text: `Recently changed files (prioritize pages using them): ${ci.changedFiles.slice(0, 12).join(', ')}`, widths: [], selector: null, source: 'git' });
  return out;
}

function rank(issue: string) {
  const i = PRIORITY.findIndex((p) => issue.startsWith(p));
  return i < 0 ? 99 : i;
}

export function summarizeIntel(ci: CodeIntel | null): string {
  if (!ci) return 'No local repository: code intelligence unavailable (black-box mode).';
  return [
    `Repo: ${ci.repo}  framework: ${ci.framework ?? 'unknown/static'}`,
    `Breakpoints: ${ci.breakpoints.join(', ') || 'none found'}`,
    `Routes from source: ${ci.routes.join(', ') || 'none found'}`,
    `Shared components: ${ci.components.map((c) => `${c.name}×${c.usages}`).join(', ') || 'none found'}`,
    `Changed files: ${ci.changedFiles.slice(0, 15).join(', ') || 'none'}`,
    `Long i18n strings: ${ci.longStrings.slice(0, 5).map((s) => JSON.stringify(s.text.slice(0, 60))).join(', ') || 'none'}`,
    `Hypothesis seeds:`,
    ...ci.hypotheses.map((h, i) => `  H${i + 1}. ${h.text}`),
  ].join('\n');
}
