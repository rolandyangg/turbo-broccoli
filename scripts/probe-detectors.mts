import { chromium, webkit } from 'playwright';
import { resolveTarget } from '../src/target/resolve.ts';
import { installDetectors, runDetectors, settle } from '../src/detect/index.ts';
const t = await resolveTarget('fixtures/buggy-site');
for (const bt of [chromium, webkit]) {
  const b = await bt.launch();
  const ctx = await b.newContext();
  await installDetectors(ctx);
  const p = await ctx.newPage();
  for (const [path, w] of [['/', 320], ['/', 700], ['/', 1280], ['/pricing.html', 360], ['/signup.html', 1280]] as const) {
    await p.setViewportSize({ width: w, height: 800 });
    await p.goto(t.baseUrl + path);
    await settle(p, 1500);
    const c = await runDetectors(p);
    console.log(`\n== ${bt.name()} ${path} @${w}`);
    for (const x of c) console.log(`  ${x.type.padEnd(18)} ${x.confidence} ${x.selector} "${x.text.slice(0,40)}" ${x.message.slice(0,80)}${x.related ? ' <-> ' + x.related.selector : ''}`);
  }
  await b.close();
}
await t.stop();
