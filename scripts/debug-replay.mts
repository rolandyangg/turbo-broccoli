// Replays a finding's steps and prints what the detectors see (debugging non-reproducing findings).
import { readFindings, findById, readRun } from '../src/store/store.ts';
import { resolveTarget } from '../src/target/resolve.ts';
import { replay } from '../src/triage/replay.ts';
import { runDetectors } from '../src/detect/index.ts';
import { Config } from '../src/config.ts';
const [runDir, id] = process.argv.slice(2);
const f = findById(readFindings(runDir)!, id)!.finding;
const info = readRun(runDir);
const t = await resolveTarget(info.repo_path!);
const steps = f.reproduction.steps_minimal.length ? f.reproduction.steps_minimal : f.reproduction.steps_original;
console.log('steps', JSON.stringify(steps).slice(0, 600));
const { driver, error } = await replay(steps, { baseUrl: t.baseUrl, browser: f.reproduction.environment.browser, initialViewport: f.reproduction.environment.viewport, guardrails: Config.parse({}).guardrails });
console.log('error', error);
await driver.page.waitForTimeout(2500);
console.log('shifts', JSON.stringify(await driver.page.evaluate('window.__bugbash.shifts')).slice(0, 400));
console.log((await runDetectors(driver.page, { only: [f.type] })).map((c) => `${c.type} ${c.confidence} ${c.selector} ${c.message}`));
await driver.close(); await t.stop();
