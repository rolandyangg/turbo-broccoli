import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFindings, readRun, allFindings } from './store.js';
import type { Finding, RootCauseGroup } from './schema.js';
import { Memory } from '../memory/siteMemory.js';
import { loadCalibration } from '../memory/calibration.js';
import { mergeAll, summarize } from '../explore/coverage.js';
import { Config } from '../config.js';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const SEV_ORDER = { critical: 0, major: 1, minor: 2, cosmetic: 3 } as const;

export function writeReport(runDir: string): { html: string; md: string } {
  const info = readRun(runDir);
  const ff = readFindings(runDir);
  const groups = ff?.groups ?? [];
  const findings = ff ? allFindings(ff) : [];
  const memory = new Memory(info.workspace);
  const calibration = loadCalibration(memory);
  const cfg = Config.parse(info.config);
  const coverage = summarize(mergeAll(runDir), cfg.viewports.widths, cfg.browsers);
  const hyps = existsSync(join(runDir, 'hypotheses.jsonl')) ? readFileSync(join(runDir, 'hypotheses.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const jobs = (info.jobs ?? []) as { id: string; goal: string; persona: string | null; browser: string; status: string; newFindings?: number; totalFindings?: number; result?: { toolCalls: number; durationMs: number } }[];

  const html = renderHtml({ info, groups, findings, calibration, coverage, hyps, jobs });
  const md = renderMd({ info, groups, findings, runDir });
  const htmlPath = join(runDir, 'report.html');
  const mdPath = join(runDir, 'summary.md');
  writeFileSync(htmlPath, html);
  writeFileSync(mdPath, md);
  return { html: htmlPath, md: mdPath };
}

function fixCmd(id: string, run: string) {
  return `bugbash fix ${id} --run ${run}`;
}

function findingCard(f: Finding, run: string) {
  const v = f.video;
  const media = v?.mp4 || v?.webm
    ? `<video controls preload="metadata" src="${esc(v.mp4 ?? v.webm)}#t=${Math.max(0, ((v.bug_at_ms ?? 0) - 3000) / 1000).toFixed(1)}" poster="${esc(f.screenshots.annotated)}"></video>${v.filmstrip ? `<a href="${esc(v.filmstrip)}" target="_blank"><img class="strip" loading="lazy" src="${esc(v.filmstrip)}" alt="filmstrip"></a>` : ''}`
    : `<a href="${esc(f.screenshots.annotated)}" target="_blank"><img loading="lazy" src="${esc(f.screenshots.crop ?? f.screenshots.annotated)}" alt="annotated screenshot"></a>`;
  const widths = f.viewports.map((x) => x.width);
  const range = widths.length > 1 ? `${Math.min(...widths)}–${Math.max(...widths)}px` : widths.length ? `${widths[0]}px` : '';
  const env = f.reproduction.environment;
  const variant = Object.entries(env.variant).filter(([k, val]) => !(k === 'colorScheme' && val === 'light') && !(k === 'fontScale' && val === 1) && !(k === 'zoom' && val === 1) && !(k === 'dpr' && val === 1) && !(k === 'reducedMotion' && !val) && !(k === 'network' && val === 'online') && !(k === 'blocked' && !(val as string[]).length));
  return `
<article class="finding" data-status="${f.status}" data-type="${f.type}" data-sev="${f.severity}" data-conf="${f.confidence}" data-browsers="${f.browsers.join(' ')}" data-persona="${esc(f.found_by.persona ?? '')}">
  <div class="media">${media}</div>
  <div class="body">
    <header>
      <span class="id">${f.id}</span>
      <span class="pill sev-${f.severity}">${f.severity}</span>
      <span class="pill st-${f.status}">${f.status.replace('_', ' ')}</span>
      ${f.history_tag !== 'new' ? `<span class="pill hist">${f.history_tag}</span>` : ''}
      <span class="conf" title="${esc(JSON.stringify(f.confidence_breakdown))}">confidence ${(f.confidence * 100).toFixed(0)}%</span>
    </header>
    <h3>${esc(f.title)}</h3>
    <p class="meta">${esc(f.type)} · ${esc(f.page)} · ${f.browsers.map(esc).join(', ')} · ${range}${variant.length ? ' · ' + esc(variant.map(([k, val]) => `${k}=${Array.isArray(val) ? val.join('/') : val}`).join(', ')) : ''}${f.found_by.persona ? ' · ' + esc(f.found_by.persona) : ''}${f.found_by.strategy ? ' · via ' + esc(f.found_by.strategy) : ''}${f.found_by.seeded_by_code_intel ? ' · <b>code-intel seed</b>' : ''}</p>
    <p>${esc(f.description)}</p>
    <div class="ea"><div><b>Expected</b> ${esc(f.reproduction.expected)}</div><div><b>Actual</b> ${esc(f.reproduction.actual)}</div></div>
    <details><summary>How to reproduce (${esc(f.reproduction.rate ?? 'not auto-verified')}${f.reproduction.rate ? ' replays' : ''})</summary>
      <p class="meta">${esc(env.browser)} · ${env.viewport.width}×${env.viewport.height}${variant.length ? ' · ' + esc(JSON.stringify(Object.fromEntries(variant))) : ''}</p>
      <ol>${f.reproduction.steps_human.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      ${f.reproduction.spec ? `<p>Executable repro: <code>${esc(f.reproduction.spec)}</code> <button class="copy" data-copy="npx playwright test -c repros/playwright.config.mjs ${esc(f.id)}">copy run command</button></p>` : ''}
      ${v?.trace ? `<p>Step-through trace: <code>npx playwright show-trace ${esc(v.trace)}</code></p>` : ''}
    </details>
    <details><summary>Cause, fix hint & source</summary>
      ${f.likely_cause ? `<p><b>Likely cause:</b> ${esc(f.likely_cause)}</p>` : ''}
      ${f.fix_hint ? `<p><b>Fix hint:</b> ${esc(f.fix_hint)}</p>` : ''}
      ${f.source_hints.length ? `<ul>${f.source_hints.map((h) => `<li><code>${esc(h.file)}${h.line ? ':' + h.line : ''}</code> — ${esc(h.reason)}</li>`).join('')}</ul>` : '<p class="meta">No source hints (no local repo).</p>'}
      <p class="meta">Selector: <code>${esc(f.element.selector)}</code></p>
      <p class="meta">Confidence: ${esc(Object.entries(f.confidence_breakdown).filter(([k, val]) => k !== 'notes' && val != null).map(([k, val]) => `${k} ${typeof val === 'number' ? val.toFixed(2) : val}`).join(' · '))}</p>
      ${f.confidence_breakdown.notes.length ? `<ul class="notes">${f.confidence_breakdown.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </details>
    <div class="actions">
      <button class="copy" data-copy="${esc(fixCmd(f.id, run))}">copy fix command</button>
      <button class="copy" data-copy="bugbash label ${esc(f.id)} false_positive --run ${esc(run)} --note &quot;&quot;">copy FP label command</button>
      ${f.fix ? `<span class="pill st-fixed">fix: ${f.fix.pr_url ? `<a href="${esc(f.fix.pr_url)}">PR</a>` : esc(f.fix.branch)}</span>` : ''}
    </div>
  </div>
</article>`;
}

function groupSection(g: RootCauseGroup, run: string) {
  const worst = [...g.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])[0]?.severity ?? 'minor';
  return `
<details class="group" open data-group="${g.id}">
  <summary>
    <span class="id">${g.id}</span>
    <span class="pill sev-${worst}">${worst}</span>
    <span class="gtitle">${esc(g.summary)}</span>
    <span class="count">${g.findings.length} finding${g.findings.length > 1 ? 's' : ''}</span>
    <span class="rollup">${esc(Object.entries(g.status_rollup).map(([k, n]) => `${n} ${k}`).join(' · '))}</span>
  </summary>
  <div class="gmeta">
    ${g.component ? `<span>Component: <code>${esc(g.component)}</code></span>` : ''}
    ${g.css_rule ? `<span>Rule: <code>${esc(g.css_rule)}</code></span>` : ''}
    ${g.files.length ? `<span>Files: ${g.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</span>` : ''}
    ${g.fix_plan ? `<p><b>Group fix plan:</b> ${esc(g.fix_plan)}</p>` : ''}
    ${g.findings.length > 1 ? `<button class="copy" data-copy="${esc(fixCmd(g.id, run))}">copy fix-group command</button>` : ''}
  </div>
  ${g.findings.map((f) => findingCard(f, run)).join('')}
</details>`;
}

function renderHtml(d: {
  info: ReturnType<typeof readRun>;
  groups: RootCauseGroup[];
  findings: Finding[];
  calibration: ReturnType<typeof loadCalibration>;
  coverage: ReturnType<typeof summarize>;
  hyps: { outcome: string; hypothesis: string; page: string; strategy: string | null }[];
  jobs: { id: string; goal: string; persona: string | null; browser: string; status: string; newFindings?: number; totalFindings?: number; result?: { toolCalls: number; durationMs: number } }[];
}) {
  const { info, groups, findings } = d;
  const active = findings.filter((f) => ['new', 'confirmed', 'fixing'].includes(f.status));
  const bySev = (s: string) => active.filter((f) => f.severity === s).length;
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const opts = (xs: string[]) => xs.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  const hypCounts = d.hyps.reduce<Record<string, number>>((a, h) => ((a[h.outcome] = (a[h.outcome] ?? 0) + 1), a), {});
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bug Bash Report</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--fg:#1b1b1f;--muted:#62636b;--line:#e3e3e8;--accent:#3355ff;--crit:#b3261e;--major:#d9480f;--minor:#9a6700;--cos:#5a6270;--ok:#1a7f37;--code:#f0f0f3}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#111214;--card:#1a1b1e;--fg:#ececf1;--muted:#a0a1aa;--line:#2c2d33;--accent:#8aa2ff;--crit:#ff6b60;--major:#ff8f4d;--minor:#e0b33c;--cos:#9aa3b2;--ok:#4cc16a;--code:#24252a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 80px}
h1{margin:0 0 4px;font-size:26px}h2{font-size:18px;margin:28px 0 10px}h3{margin:4px 0;font-size:16px}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:12.5px;word-break:break-all}
.meta{color:var(--muted);font-size:13px;margin:2px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.stat b{display:block;font-size:22px}
.filters{position:sticky;top:0;z-index:5;background:var(--bg);padding:10px 0;display:flex;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--line)}
.filters select,.filters input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font:inherit;font-size:13px}
.group{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:14px 0;overflow:hidden}
.group>summary{cursor:pointer;padding:12px 14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;list-style:none;border-bottom:1px solid var(--line)}
.group>summary::-webkit-details-marker{display:none}.gtitle{font-weight:600;flex:1 1 280px}.count,.rollup{color:var(--muted);font-size:13px}
.gmeta{padding:8px 14px;display:flex;flex-wrap:wrap;gap:12px;font-size:13px;color:var(--muted);border-bottom:1px dashed var(--line)}.gmeta p{flex-basis:100%;margin:0;color:var(--fg)}
.finding{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:16px;padding:14px;border-top:1px solid var(--line)}
.finding:first-of-type{border-top:0}
@media (max-width:760px){.finding{grid-template-columns:1fr}}
.media img,.media video{width:100%;border-radius:8px;border:1px solid var(--line);background:#000;display:block}.media .strip{margin-top:6px;background:transparent}
.finding header{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.id{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:13px}
.pill{font-size:11.5px;padding:1px 8px;border-radius:999px;border:1px solid currentColor;text-transform:uppercase;letter-spacing:.03em}
.sev-critical{color:var(--crit)}.sev-major{color:var(--major)}.sev-minor{color:var(--minor)}.sev-cosmetic{color:var(--cos)}
.st-new,.st-confirmed{color:var(--accent)}.st-fixed{color:var(--ok)}.st-low_confidence,.st-flaky,.st-suppressed,.st-false_positive{color:var(--muted)}.hist{color:var(--major)}
.conf{margin-left:auto;font-size:13px;color:var(--muted)}
.ea{display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13.5px;margin:6px 0}@media (max-width:760px){.ea{grid-template-columns:1fr}}
.ea div{background:var(--code);border-radius:8px;padding:6px 10px}
details>summary{cursor:pointer;color:var(--accent);font-size:13.5px;margin-top:4px}
ol{padding-left:22px;margin:6px 0}.notes{font-size:12.5px;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
button.copy{font:inherit;font-size:12.5px;background:transparent;color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:3px 9px;cursor:pointer}
button.copy.done{color:var(--ok)}
table{border-collapse:collapse;width:100%;font-size:13px;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.scroll{overflow-x:auto}
.hidden{display:none!important}
</style></head>
<body><main>
<h1>Bug bash report</h1>
<p class="meta">Target <code>${esc(info.target)}</code> (${esc(info.base_url)}) · run <code>${esc(info.run_id)}</code> · ${esc(info.started_at)}${info.head_commit ? ` · commit <code>${esc(info.head_commit.slice(0, 10))}</code>` : ''}</p>
<div class="stats">
  <div class="stat"><b>${active.length}</b>active findings</div>
  <div class="stat"><b style="color:var(--crit)">${bySev('critical')}</b>critical</div>
  <div class="stat"><b style="color:var(--major)">${bySev('major')}</b>major</div>
  <div class="stat"><b style="color:var(--minor)">${bySev('minor')}</b>minor</div>
  <div class="stat"><b>${groups.length}</b>root-cause groups</div>
  <div class="stat"><b>${findings.filter((f) => f.evidence_kind === 'temporal').length}</b>with video</div>
  <div class="stat"><b>${d.jobs.length}</b>explorer sessions</div>
  <div class="stat"><b>${d.hyps.length}</b>hypotheses (${hypCounts.confirmed ?? 0} confirmed)</div>
</div>
<div class="filters">
  <select id="f-status"><option value="active">Active (new/confirmed)</option><option value="">All statuses</option>${opts(uniq(findings.map((f) => f.status)))}</select>
  <select id="f-sev"><option value="">All severities</option>${opts(['critical', 'major', 'minor', 'cosmetic'])}</select>
  <select id="f-type"><option value="">All types</option>${opts(uniq(findings.map((f) => f.type)))}</select>
  <select id="f-browser"><option value="">All browsers</option>${opts(uniq(findings.flatMap((f) => f.browsers)))}</select>
  <select id="f-persona"><option value="">All personas</option>${opts(uniq(findings.map((f) => f.found_by.persona ?? '').filter(Boolean)))}</select>
  <label class="meta">min confidence <input id="f-conf" type="number" min="0" max="1" step="0.05" value="0" style="width:70px"></label>
</div>
<section id="groups">${groups.map((g) => groupSection(g, info.run_id)).join('') || '<p>No findings.</p>'}</section>

<h2>How the lead agent ran the campaign</h2>
<p><b>Stop reason:</b> ${esc(info.stop_reason ?? 'n/a')}</p>
${info.lead_decisions?.length ? `<ol>${info.lead_decisions.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '<p class="meta">No lead decisions recorded.</p>'}
<div class="scroll"><table><tr><th>Session</th><th>Browser</th><th>Persona</th><th>Goal</th><th>New / total</th><th>Tool calls</th><th>Time</th></tr>
${d.jobs.map((j) => `<tr><td>${esc(j.id)}</td><td>${esc(j.browser)}</td><td>${esc(j.persona ?? '—')}</td><td>${esc(j.goal)}</td><td>${j.newFindings ?? '—'} / ${j.totalFindings ?? '—'}</td><td>${j.result?.toolCalls ?? '—'}</td><td>${j.result ? Math.round(j.result.durationMs / 1000) + 's' : '—'}</td></tr>`).join('')}
</table></div>

<h2>Coverage</h2>
<div class="scroll"><table><tr><th>Page</th><th>States</th><th>Elements tried/seen</th><th>Widths tested</th><th>Browsers</th><th>Variants</th><th>Strategies untried</th></tr>
${d.coverage.map((c) => `<tr><td><code>${esc(c.page)}</code></td><td>${c.states}</td><td>${c.interactives_tried}/${c.interactives_seen}</td><td>${esc(c.widths_tested.join(', '))}</td><td>${esc(c.browsers_tested.join(', '))}</td><td>${esc(c.variants_tested.join(', ') || '—')}</td><td class="meta">${esc(c.strategies_untried.join(', '))}</td></tr>`).join('')}
</table></div>

<h2>Confidence calibration</h2>
${d.calibration ? `<p class="meta">Fitted ${esc(d.calibration.fitted_at)} from your labels and benchmark runs. Precision = share of findings in that raw-confidence bin that were real.</p><table><tr><th>Raw confidence</th><th>Labeled findings</th><th>Observed precision</th></tr>${d.calibration.table.map((r) => `<tr><td>${r.bin}</td><td>${r.count}</td><td>${r.precision == null ? '—' : Math.round(r.precision * 100) + '%'}</td></tr>`).join('')}</table>` : '<p class="meta">Not calibrated yet. Label findings (<code>bugbash label</code>) or run <code>bugbash bench</code>, then <code>bugbash calibrate</code>.</p>'}
</main>
<script>
const $=(s)=>document.querySelector(s);
function apply(){
  const st=$('#f-status').value,sev=$('#f-sev').value,type=$('#f-type').value,br=$('#f-browser').value,pe=$('#f-persona').value,conf=parseFloat($('#f-conf').value||'0');
  document.querySelectorAll('.finding').forEach(el=>{
    const d=el.dataset;
    const okSt=st==='active'?['new','confirmed','fixing'].includes(d.status):(!st||d.status===st);
    const ok=okSt&&(!sev||d.sev===sev)&&(!type||d.type===type)&&(!br||d.browsers.split(' ').includes(br))&&(!pe||d.persona===pe)&&parseFloat(d.conf)>=conf;
    el.classList.toggle('hidden',!ok);
  });
  document.querySelectorAll('.group').forEach(g=>g.classList.toggle('hidden',!g.querySelector('.finding:not(.hidden)')));
}
document.querySelectorAll('.filters select,.filters input').forEach(e=>e.addEventListener('input',apply));apply();
document.addEventListener('click',e=>{const b=e.target.closest('button.copy');if(!b)return;e.preventDefault();navigator.clipboard?.writeText(b.dataset.copy).then(()=>{b.classList.add('done');const t=b.textContent;b.textContent='copied';setTimeout(()=>{b.textContent=t;b.classList.remove('done')},1200)})});
</script>
</body></html>`;
}

function renderMd(d: { info: ReturnType<typeof readRun>; groups: RootCauseGroup[]; findings: Finding[]; runDir: string }) {
  const { info, groups } = d;
  const lines: string[] = [];
  lines.push(`# Bug bash summary — ${info.target}`, '', `Run \`${info.run_id}\` · ${info.base_url} · stop reason: ${info.stop_reason ?? 'n/a'}`, '');
  const active = d.findings.filter((f) => ['new', 'confirmed', 'fixing'].includes(f.status));
  lines.push(`**${active.length} active findings** in ${groups.length} root-cause groups (${d.findings.length} total incl. low-confidence/flaky/suppressed). Full report: \`report.html\`.`, '');
  for (const g of groups) {
    const act = g.findings.filter((f) => ['new', 'confirmed', 'fixing', 'fixed'].includes(f.status));
    if (!act.length) continue;
    lines.push(`## ${g.id} — ${g.summary}`, '');
    if (g.fix_plan) lines.push(`Fix plan: ${g.fix_plan}${g.files.length ? ` (files: ${g.files.map((f) => `\`${f}\``).join(', ')})` : ''}`, '');
    for (const f of act) {
      const widths = f.viewports.map((v) => v.width);
      lines.push(`### ${f.id} [${f.severity}, ${(f.confidence * 100).toFixed(0)}%] ${f.title}`);
      lines.push(`- ${f.type} on \`${f.page}\` · ${f.browsers.join(', ')} · ${widths.length ? `${Math.min(...widths)}–${Math.max(...widths)}px` : ''} · repro ${f.reproduction.rate ?? 'n/a'} · ${f.evidence_kind}`);
      lines.push(`- Expected: ${f.reproduction.expected}`, `- Actual: ${f.reproduction.actual}`);
      lines.push(`- Steps:`, ...f.reproduction.steps_human.map((s, i) => `  ${i + 1}. ${s}`));
      lines.push(`- Evidence: \`${f.video?.mp4 ?? f.screenshots.annotated}\`${f.reproduction.spec ? ` · spec \`${f.reproduction.spec}\`` : ''}`);
      if (f.source_hints.length) lines.push(`- Source: ${f.source_hints.slice(0, 3).map((h) => `\`${h.file}${h.line ? ':' + h.line : ''}\``).join(', ')}`);
      if (f.fix_hint) lines.push(`- Fix hint: ${f.fix_hint}`);
      lines.push('');
    }
  }
  const others = d.findings.filter((f) => !['new', 'confirmed', 'fixing', 'fixed'].includes(f.status));
  if (others.length) {
    lines.push('## Not shown above (low confidence / flaky / suppressed / false positive)', '');
    for (const f of others) lines.push(`- ${f.id} [${f.status}, ${(f.confidence * 100).toFixed(0)}%] ${f.title}`);
  }
  return lines.join('\n') + '\n';
}
