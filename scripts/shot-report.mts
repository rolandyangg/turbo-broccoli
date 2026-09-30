// Screenshot a report.html (for checking the report layout).
import { chromium } from 'playwright';
const [file, out, width] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Number(width ?? 1280), height: 1000 } });
await p.goto('file://' + file);
await p.screenshot({ path: out });
await b.close();
