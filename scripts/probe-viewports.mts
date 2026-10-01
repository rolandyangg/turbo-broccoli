// What does a page actually "see" after the explorer resizes? Compares resize-in-place (what explorers do)
// with a fresh context created at that size, and with real mobile emulation.
import { chromium, webkit, firefox, devices } from 'playwright';
import { resolveTarget } from '../src/target/resolve.ts';
const t = await resolveTarget('fixtures/buggy-site');
const probe = `(() => ({
  inner: innerWidth + 'x' + innerHeight,
  client: document.documentElement.clientWidth,
  mq399: matchMedia('(max-width: 399px)').matches,
  coarse: matchMedia('(pointer: coarse)').matches,
  hoverNone: matchMedia('(hover: none)').matches,
  touch: navigator.maxTouchPoints,
  dpr: devicePixelRatio,
  ua: /Mobile/.test(navigator.userAgent) ? 'mobile' : 'desktop',
  scrollbar: innerWidth - document.documentElement.clientWidth,
}))()`;
const noMeta = `data:text/html,<body style="margin:0"><div id=w style="width:100%25">x</div><script>document.title=document.getElementById('w').offsetWidth</script>`;
for (const [name, bt] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]] as const) {
  const b = await bt.launch();
  // 1) explorer-style: context created at 1280x800, then resized to 375x740
  const c1 = await b.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: false });
  const p1 = await c1.newPage();
  await p1.goto(t.baseUrl + '/pricing');
  await p1.setViewportSize({ width: 375, height: 740 });
  await p1.waitForTimeout(200);
  const resized = await p1.evaluate(probe);
  // 2) fresh desktop context at 375
  const c2 = await b.newContext({ viewport: { width: 375, height: 740 } });
  const p2 = await c2.newPage();
  await p2.goto(t.baseUrl + '/pricing');
  const fresh = await p2.evaluate(probe);
  // 3) real phone emulation (not supported on firefox)
  let phone: unknown = 'n/a (firefox has no isMobile)';
  let noMetaWidth: unknown = 'n/a';
  if (name !== 'firefox') {
    const c3 = await b.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined } as never);
    const p3 = await c3.newPage();
    await p3.goto(t.baseUrl + '/pricing');
    phone = await p3.evaluate(probe);
    await p3.goto(noMeta);
    noMetaWidth = await p3.title();
    await c3.close();
  }
  await p2.goto(noMeta);
  const noMetaDesktop = await p2.title();
  console.log(`\n== ${name}`);
  console.log(' resized 1280→375 :', JSON.stringify(resized));
  console.log(' fresh @375       :', JSON.stringify(fresh));
  console.log(' iPhone 13 emul.  :', JSON.stringify(phone));
  console.log(` page WITHOUT <meta viewport>: layout width desktop@375=${noMetaDesktop}px, phone-emulated=${noMetaWidth}px`);
  await b.close();
}
await t.stop();
