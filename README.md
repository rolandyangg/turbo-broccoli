# bugbash

Agentic UI bug-bashing for any web app: a live URL, a local static folder, or a local repo.

Claude agents drive guarded Playwright browsers. They guess where the layout is fragile, try many paths and sizes to break it, and record defects: clipped or overflowing text, overlaps, crowded or tiny tap targets, horizontal scroll, layout shifts, and broken states. Each defect gets an annotated screenshot or narrated video, minimal repro steps, an executable repro test, a calibrated confidence score, and a root-cause group. Fixes only happen when you ask for them, on their own branch, verified, with an optional PR.

```
explore ──► triage ──► (you decide) ──► fix
 lead agent     cluster · replay ×3 · minimize        worktree + branch
 └ explorers    annotate · video · repro spec         fix agent ⟲ verify
   (personas ×  independent review · root causes      commit · PR
    browsers)   calibrated confidence · report
```

## Requirements
- Node 22+, and Claude Code (`claude`) logged in. All agents run as headless `claude -p` under your subscription, so no API key is needed.
- `ffmpeg` for mp4/GIF/filmstrip output (optional; the webm video and screenshots still work without it).
- `gh` (logged in) for `--pr`.

```bash
npm install
npx playwright install chromium webkit firefox
```

## Usage

```bash
# Bug-bash a local repo (dev server auto-started), a static folder, or a URL
./bin/bugbash.js explore ../my-app --then-triage
./bin/bugbash.js explore https://staging.example.com --repo ../my-app --then-triage
./bin/bugbash.js explore https://example.com --browsers chromium --budget-sessions 4   # black-box, cheap

# Triage separately (re-runnable; uses the latest run by default)
./bin/bugbash.js triage [--run <id|path>] [--no-video] [--no-review]

# Look at results
./bin/bugbash.js list            # grouped by root cause, one line per finding
open <workspace>/latest/report.html

# Teach it
./bin/bugbash.js label BB-0009 false_positive --note "intentional truncation"   # suppresses similar findings next time
./bin/bugbash.js label BB-0003 confirmed
./bin/bugbash.js regroup BB-0012 RC-005        # or: regroup BB-0012 new
./bin/bugbash.js group                         # redo root-cause grouping for a run (findings untouched)
./bin/bugbash.js calibrate                     # fit confidence calibration from labels

# Fix, only when you want to
./bin/bugbash.js fix BB-0007                   # just this finding
./bin/bugbash.js fix BB-0007 BB-0011           # these together, one branch
./bin/bugbash.js fix RC-002 --pr --draft       # the whole root cause, push + draft PR

# Measure it on the seeded fixture
./bin/bugbash.js bench [--black-box] [--no-lead]
```

The workspace defaults to `<repo>/.bugbash` (or `./.bugbash` for URLs). Use `--out <dir>` to choose another location. Useful `explore` flags: `--budget-sessions`, `--parallel`, `--max-calls`, `--time-limit <min>`, `--browsers`, `--start /a,/b`, `--model`, `--dev-command`, `--no-lead`, `--no-code-intel`. Defaults can also go in `bugbash.config.json` in the target repo (see `src/config.ts`).

In Claude Code, the `bugbash` skill (`.claude/skills/bugbash`) wraps all of this, so you can ask it in plain language: "bug bash localhost:3000", "BB-9 is intentional", "fix RC-002 as a draft PR".

## How it works

**Explore (fully agentic).**
- **Code intel** (when source is available) scans CSS and markup before any browsing. It collects exact breakpoints, risky rules with `file:line` (fixed heights with `overflow: hidden`, nowrap, negative margins, absolute positioning, fixed widths), shared components, routes, long i18n strings and recently changed files. These become hypothesis seeds.
- The **lead agent** (`src/explore/prompts/lead.md`) reads memory, code intel and the site map. It plans goals across personas and browsers, then spawns explorers asynchronously and re-plans after each batch: it doubles down where bugs cluster, calls `hunt_siblings` for bugs in shared components, re-checks Chromium bugs in WebKit and Firefox, and fills coverage gaps. It stops when new findings dry up (saturation) or the budget runs out. Budgets are enforced by the CLI, not the agent.
- **Explorers** (`prompts/explorer.md` + `prompts/personas/*`) loop guess → probe → confirm over the bugbash MCP browser (`src/mcp/browserServer.ts`). The browser tools are `observe`, `click`, `rapid_click`, `hover`, `type`, `stress_fill`, `mutate_text`, `resize`, `set_variant` (dark mode, 200% text, zoom, DPR, reduced motion, offline/slow-3G, blocked fonts/images), `sweep_viewports`, `run_detectors`, `find_similar`, `record_finding`, `log_hypothesis`, `coverage`, `strategy_coverage` and `notes`.
- **Guardrails** are enforced in code: same-origin only, destructive-click denylist, non-GET requests blocked (they return 503), dialogs auto-dismissed. Every action is logged as a replayable step.
- **Detectors** (`src/detect/inpage.js`) measure geometry: clipped text, text spilling out of its box, overlaps (distinguishing collisions from intentional layering), spacing, viewport overflow, tap targets, broken images and layout shift. They are hints; the agents judge the screenshots.

**Triage.** Findings are clustered across sessions, widths and browsers. Each is replayed 3× in fresh browsers for a reproduction rate and delta-debugged down to its minimal steps. Then it is annotated (a red box on the defect, orange on the related element). Timing bugs get a narrated video: step captions, a ring on each clicked element, the bug boxed and held, plus mp4, GIF, filmstrip and a Playwright trace. An independent reviewer (fresh context, no explorer reasoning) judges each finding from the evidence alone. Findings are grouped by root cause with source files, and scored as a blend of explorer, reviewer, detector and reproduction signals, then calibrated from your labels. Known false-positive patterns are suppressed.

**Fix.** A git worktree on `bugbash/<scope>-<slug>` is created. The fix agent (Read/Grep/Glob/Edit only) gets the findings, evidence and group context. Verification replays the repro at every affected viewport and browser and compares detector snapshots of the touched pages to catch regressions, retrying with feedback. It then commits, optionally pushes and opens a PR with before/after images, and records per-finding fix status. It also reports other findings in the group that the change happened to resolve.

## Output (per run: `<workspace>/runs/<timestamp>/`)

| File | What |
|---|---|
| `findings.json` | **Main record.** `{schemaVersion, groups: [{id: RC-…, summary, component, css_rule, files, fix_plan, status_rollup, findings: [Finding…]}]}`. Groups are advisory; every finding is a complete record with its own id, status, evidence, repro and fix info. |
| `findings.flat.jsonl` | One finding per line, for scripts and other tools. |
| `report.html` | Filterable report: groups → findings, screenshots/video, steps, expected/actual, source hints, copy-able fix commands, campaign decisions, coverage, calibration. |
| `summary.md` | Markdown summary (good for issues and PRs). |
| `shots/`, `videos/`, `traces/` | Annotated/crop/full screenshots; mp4/GIF/webm/filmstrip; Playwright traces (`npx playwright show-trace`). |
| `repros/BB-xxxx.spec.ts` | Playwright tests that **fail while the bug exists**: `npx playwright test -c repros/playwright.config.mjs` (set `BUGBASH_BASE_URL`). |
| `agent-findings.jsonl`, `hypotheses.jsonl`, `sessions/`, `transcripts/`, `coverage/`, `notes.md` | Raw explorer output, every hypothesis tried, action logs, full agent transcripts. |
| `run.json` | Target, config, sessions, lead decisions, stop reason. |

Memory across runs (`<workspace>/memory/`): `site.json`, `known_bugs.json` (findings are tagged new/recurring/regressed), `fp_patterns.json`, `labels.jsonl`, `calibration.json` and `lessons.md`. It's all plain JSON/Markdown, so you can edit it.

The key fields of a `Finding` (schema in `src/store/schema.ts`): `id`, `root_cause_id`, `type`, `title`, `description`, `severity`, `confidence` + `confidence_breakdown`, `status`, `found_by{persona,strategy,hypothesis}`, `page`, `browsers`, `viewports`, `element{selector,text,bbox}`, `metrics`, `reproduction{rate, environment, steps_human, expected, actual, steps_minimal, steps_original, spec}`, `evidence_kind`, `screenshots`, `video`, `source_hints`, `fix_hint`, `fix{branch, pr_url, verified}`.

## Web app (`web/`)

**TurboBrocolli** is a local dashboard, run viewer and fix control room, kept separate from the agent code. It has a Greptile-style UI (dashed boxes, Anybody/DM Sans/Space Mono), is dark by default with a light/system toggle, and is built with Vite + React on a small Hono API that reads run folders from disk.

```bash
npm run web:install        # once
npm run web                # http://127.0.0.1:4317  (API on :4318)
npm run web:build && npm run web:start   # production build, one server on :4317
```

It finds every workspace automatically: the CLI records each one in `~/.bugbash/workspaces.json`. You can also add one with `BUGBASH_WORKSPACES=/a/.bugbash:/b/.bugbash npm run web` or the "Add a workspace" box on the Runs page.

**What you can do**
- **Dashboard (home):** the current state across targets, taken from each target's latest triaged run. It shows:
  - KPI tiles;
  - active bugs per run, stacked by severity;
  - severity breakdown and the fix pipeline;
  - the most severe open bugs;
  - recent jobs;
  - bug types, pages and browsers.

  Every chart has hover tooltips and a table view.
- **Runs:** every run from every workspace, with counts and live status.
- **Run:**
  - root-cause sections, each with a "Fix whole group" button;
  - bug cards you can multi-select for a "Fix selected (n)" action;
  - filters: status, severity, type, browser, persona, confidence, search;
  - tabs for lead-agent decisions and explorer sessions, coverage, hypotheses, code intel, and jobs.
- **Bug:** every field of the finding:
  - evidence: annotated, close-up and full-page screenshots, the explorer's own shot, and a filmstrip;
  - video with an **annotated timeline**: step markers, a red BUG marker, the current step shown beside the player, jump-to-bug, speed and frame stepping. Clicking a repro step jumps the video to it;
  - expected/actual, minimal and original traces, the repro spec, and a Playwright trace download;
  - source hints, measurements, the confidence breakdown, found-by, triage notes, and the explorer transcript that led to the finding;
  - the raw JSON.
- **Fix:** starts `bugbash fix` as a background job on a new branch. You follow it live: a stage timeline, the agent's actions, and per-browser/width verify results. A branch panel shows commits, changed files, the diff, and PR status and checks.
  - Opening a PR requires an explicit "this pushes to origin" confirmation.
- **Label and regroup:** confirm, mark false positive (with a suppression scope), or move a finding to another group.
- **New bug bash / re-triage:** launch explore (with optional triage) and watch explorer sessions live.

Jobs run as detached CLI processes. Their status and events are written to disk (`~/.bugbash/web-jobs/`, or `<run>/jobs/` for CLI-started jobs), so they survive page reloads and server restarts. The server binds to 127.0.0.1 only, and it serves run files with a path-traversal guard and HTTP Range support for video seeking.

## Development

```bash
npm test          # detectors, MCP session/guardrails/replay, units (no LLM calls)
npm run typecheck
./bin/bugbash.js bench --budget-sessions 6     # end-to-end with agents on fixtures/buggy-site
```
`fixtures/buggy-site` seeds 11 bugs (static, interaction-only, timing, WebKit-only, shared-component) plus guardrail traps. They are listed in `bench/manifest.json`, and results are written to `bench/results/`.
