import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import type { CodeIntel } from '../explore/codeIntel.js';

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.bugbash', 'coverage', '.turbo', '.svelte-kit', '.nuxt', 'vendor']);
const EXTS = new Set(['.css', '.scss', '.sass', '.less', '.html', '.htm', '.jsx', '.tsx', '.js', '.ts', '.vue', '.svelte', '.astro', '.mdx']);

export interface SourceHint {
  file: string;
  line: number | null;
  reason: string;
  score: number;
}

/** Indexes a repo's source files once, then answers "where does this element come from?" queries. */
export class SourceIndex {
  private files: { rel: string; lines: string[]; isStyle: boolean }[] = [];

  constructor(readonly repo: string, private intel: CodeIntel | null) {
    const walk = (d: string, depth = 0) => {
      if (depth > 12 || this.files.length > 4000) return;
      for (const e of readdirSync(d)) {
        if (IGNORE.has(e) || e.startsWith('.')) continue;
        const p = join(d, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, depth + 1);
        else if (EXTS.has(extname(e)) && st.size < 800_000) {
          try {
            this.files.push({ rel: relative(repo, p), lines: readFileSync(p, 'utf8').split('\n'), isStyle: /\.(css|scss|sass|less)$/.test(e) });
          } catch {}
        }
      }
    };
    walk(repo);
  }

  hints(o: { selector: string | null; text: string | null; type: string }): SourceHint[] {
    const out = new Map<string, SourceHint>();
    const add = (file: string, line: number | null, reason: string, score: number) => {
      const k = `${file}:${line}`;
      const prev = out.get(k);
      if (prev) {
        prev.score += score;
        if (!prev.reason.includes(reason)) prev.reason += `; ${reason}`;
      } else out.set(k, { file, line, reason, score });
    };
    const leaf = (o.selector ?? '').split('>').slice(-2).join(' ');
    const classes = [...new Set([...leaf.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]))];
    const ids = [...leaf.matchAll(/#([a-zA-Z_][\w-]*)/g)].map((m) => m[1]);
    const testids = [...(o.selector ?? '').matchAll(/data-(?:testid|test|cy|qa)="([^"]+)"/g)].map((m) => m[1]);
    const text = (o.text ?? '').trim().slice(0, 40);

    for (const f of this.files) {
      f.lines.forEach((line, i) => {
        for (const c of classes) {
          const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (f.isStyle || /<style/.test(f.lines.slice(Math.max(0, i - 200), i + 1).join('\n'))) {
            if (new RegExp(`\\.${esc}(?![\\w-])[^{]*\\{?`).test(line) && /[{,]\s*$|\{/.test(line)) add(f.rel, i + 1, `CSS rule for .${c}`, 3);
          } else if (new RegExp(`class(Name)?=[^>]*\\b${esc}\\b`).test(line) || new RegExp(`['"\`\\s]${esc}['"\`\\s]`).test(line)) add(f.rel, i + 1, `markup uses .${c}`, 2);
        }
        for (const id of ids) if (line.includes(`id="${id}"`) || line.includes(`#${id}`)) add(f.rel, i + 1, `#${id}`, 2);
        for (const t of testids) if (line.includes(t)) add(f.rel, i + 1, `test id ${t}`, 4);
        if (text.length >= 6 && !f.isStyle && line.includes(text)) add(f.rel, i + 1, `contains text "${text}"`, 3);
      });
    }
    // Risky rules from code intel that match the element's classes get a strong boost.
    for (const r of this.intel?.risky ?? []) {
      if (classes.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(r.selector))) add(r.file, r.line, `risky CSS: ${r.issue} (${r.decl})`, 5);
    }
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 6);
  }
}
