import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { Finding } from '../store/schema.js';
import { tsxServer } from '../llm/runner.js';

const BROWSER_TOOLS = ['observe', 'screenshot', 'goto', 'back', 'forward', 'reload', 'click', 'hover', 'type', 'select', 'press', 'scroll', 'resize', 'set_variant', 'set_device', 'check_focus', 'run_detectors', 'sweep_devices', 'sweep_viewports', 'find_similar', 'log_hypothesis'];

/** Independent, traced browser sessions against the fix worktree's running server. */
export function fixBrowserTools(selected: Finding[], config: Config, baseUrl: string, outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const configPath = join(outDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const browsers = [...new Set(selected.flatMap((f) => f.browsers.length ? f.browsers : [f.reproduction.environment.browser]))];
  const mcpServers = Object.fromEntries(browsers.map((browser) => {
    const finding = selected.find((f) => f.browsers.includes(browser) || f.reproduction.environment.browser === browser)!;
    return [`fix_${browser}`, tsxServer(join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'browserServer.ts'), {
      BUGBASH_CONFIG: configPath,
      BUGBASH_RUN_DIR: outDir,
      BUGBASH_BASE_URL: baseUrl,
      BUGBASH_SESSION: `fix-${browser}`,
      BUGBASH_BROWSER: browser,
      BUGBASH_START_PATH: finding.page,
      BUGBASH_VIEWPORT: JSON.stringify(finding.reproduction.environment.viewport),
      BUGBASH_DEVICE: finding.reproduction.environment.variant.device ?? '',
      BUGBASH_PERSONA: '',
      BUGBASH_TOOLSET: 'full',
      BUGBASH_MAX_CALLS: '120',
      BUGBASH_EXCLUDE_STRATEGIES: '',
      BUGBASH_ALLOWED_DEVICES: '',
    })];
  }));
  return { mcpServers, allowedTools: Object.keys(mcpServers).flatMap((name) => BROWSER_TOOLS.map((tool) => `mcp__${name}__${tool}`)) };
}
