---
name: bugbash
description: Agentically bug-bash a web app's UI (layout defects across sizes, browsers, personas), triage findings with screenshots/videos/repro steps, and — only when explicitly asked — fix selected findings on a branch and open a PR. Use when the user wants to find UI bugs, bug bash a site/URL/local app, review bugbash findings, label false positives, or fix specific BB-/RC- ids.
---

# bugbash

`bugbash` is a CLI in this repo (`./bin/bugbash.js`, or `npx tsx src/cli.ts`). It runs Claude agents headlessly under the user's Claude Code login. Three stages:

1. **explore**: a lead agent plans a campaign and spawns explorer agents that drive guarded Playwright browsers. They guess where the layout is weak, attack it (sizes, long text, rapid clicks, zoom, dark mode, offline…), and record findings.
2. **triage**: clusters findings, replays them 3× in fresh browsers, minimizes the repro steps, and annotates them (screenshot, or a narrated video for timing bugs). It also gets an independent LLM review, groups findings by root cause, and scores confidence. Output goes to `findings.json`, `report.html` and `summary.md`.
3. **fix**: **only when the user explicitly names findings to fix.** Creates a branch in a git worktree, runs a fix agent, verifies with the repro checks, commits, and optionally opens a PR.

## Explore + triage

```bash
./bin/bugbash.js explore <url|folder|repo> --then-triage [--repo <src>] [--budget-sessions 12] [--browsers chromium,webkit,firefox]
```
- Local repo with a `dev`/`start` script: started automatically. Static folder: served. URL: black-box unless `--repo` points at its source.
- Long-running (several minutes up to the time limit). Run it in the background and tell the user it's running.
- Cheaper runs: `--preset quick`, or `--budget-sessions 4 --max-calls 50 --browsers chromium`, or `--no-lead` for a fixed plan.
- Presets: `standard` (default), `quick`, `mobile`, `desktop`, `deep`. Narrow a run with `--personas`, `--persona-sessions phone-user=3`, `--devices`, `--strategies` / `--exclude-strategies`, `--focus /a,/b`; the lead is held to these strictly.

## Presenting results
Run `./bin/bugbash.js list [--run <id|path>]` (add `--all` to include low-confidence, flaky and suppressed findings), or read `<run>/summary.md` / `findings.json`. Summarize **by root-cause group, listing each finding individually**, with severity and confidence, a one-line expected-vs-actual, and the page and widths. Point the user to `report.html` for screenshots and videos. Don't paste whole JSON.

## Labeling (conversational)
When the user says something like "BB-0009 is intentional" or "that's not a bug":
`./bin/bugbash.js label BB-0009 false_positive --note "<their reason>" [--pattern-scope element|component|type-on-page]`
This suppresses matching findings in future runs and feeds confidence calibration. `confirmed` works the same way. After enough labels, run `./bin/bugbash.js calibrate`.
Moving a finding between groups: `./bin/bugbash.js regroup BB-0012 RC-005` (or `new`). Redo all grouping for a run: `./bin/bugbash.js group`.

## Reproducing
To show the user a bug live: `./bin/bugbash.js reproduce BB-0007` opens a real browser window with the bug's exact browser, device and settings, replays it, and highlights the bug. It opens a window on their screen, so only run it when they ask to see a bug. Use `--mode start` to just open the page in that environment.

## Fixing — only on explicit request
- Never run `fix` unless the user asks to fix specific findings or groups.
- `fix BB-0007` fixes only that finding. `fix BB-0007 BB-0011` fixes those together on one branch. `fix RC-002` fixes the whole root-cause group.
- It requires a clean git tree in the target repo.
- **Ask before adding `--pr`**, because it pushes a branch and opens a GitHub PR. Suggest `--draft`. Mention that before/after images are committed under `.bugbash/pr-assets/` in a separate commit unless `--no-pr-assets` is used.
- Report the result: whether it was verified, the branch, the PR URL, and any other findings the fix also resolved.

## Learning loop — the user approves, not you
- After triage, a retrospective (`./bin/bugbash.js retro`) files proposals: lessons, strategy priors, detector suggestions and prompt/config tweaks. They change nothing until approved.
- Show pending proposals with `improvements list`. Only run `improvements approve|reject <P-id>` when the user decides on that specific item; never approve in bulk on your own.
- `improve <B-id>` implements an approved backlog item on an `improve/*` branch (typecheck + tests). Ask before `--pr`.

## Compare, notifications, schedules
- Compare two runs in the web app at `/compare?a=<ws>/<run>&b=<ws>/<run>` (also linked from run pages).
- Notification channels and events are set on the web app's Settings page; don't change them unless asked.
- `schedule add|list|enable|disable|run-now|remove` manages macOS launchd schedules. Only add or enable one when the user asks for scheduled runs, and say it only runs while the Mac is awake and they're logged in.

## Web app
For browsing results, pointing the user to the UI is often better than pasting results. `npm run web` serves http://127.0.0.1:4317, where they can view every bug with its screenshots, annotated video and repro steps, start fixes and watch them live. Start it in the background if they ask to see results visually.
