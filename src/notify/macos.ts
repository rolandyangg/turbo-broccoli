import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { execa } from 'execa';

const preparing = new Map<string, Promise<string>>();

export function prepareMacNotifier(root: string): Promise<string> {
  let pending = preparing.get(root);
  if (!pending) {
    pending = build(root).catch((error) => { preparing.delete(root); throw error; });
    preparing.set(root, pending);
  }
  return pending;
}

async function build(root: string) {
  // Resolve from the repository for both tsx and compiled CLI execution.
  const source = fileURLToPath(new URL('../../src/notify/macos/Notifier.swift', import.meta.url));
  const version = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 12);
  const finalDirectory = join(root, 'macos-notifier', version);
  const finalApp = join(finalDirectory, 'TurboBrocolli.app');
  if (existsSync(join(finalDirectory, 'ready'))) return finalApp;
  mkdirSync(join(root, 'macos-notifier'), { recursive: true });
  const directory = mkdtempSync(join(root, 'macos-notifier', '.build-'));
  try {
    const app = join(directory, 'TurboBrocolli.app');
    const contents = join(app, 'Contents');
    const executable = join(contents, 'MacOS', 'TurboBrocolli');
    const ready = join(directory, 'ready');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    const iconset = join(directory, 'Broccoli.iconset');
    mkdirSync(iconset, { recursive: true });
    await execa('xcrun', ['swiftc', source, '-o', executable, '-module-cache-path', join(directory, 'module-cache')], { timeout: 120000 });
    await execa(executable, ['--icon', iconset], { timeout: 10000 });
    await execa('iconutil', ['-c', 'icns', iconset, '-o', join(contents, 'Resources', 'Broccoli.icns')]);
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.turbobrocolli.notifications</string>
  <key>CFBundleName</key><string>TurboBrocolli</string>
  <key>CFBundleExecutable</key><string>TurboBrocolli</string>
  <key>CFBundleIconFile</key><string>Broccoli</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeExtensions</key><array><string>json</string></array><key>CFBundleTypeRole</key><string>Viewer</string></dict></array>
  </dict></plist>`);
    await execa('codesign', ['--force', '--sign', '-', app]);
    writeFileSync(ready, version);
    try {
      renameSync(directory, finalDirectory);
    } catch (error) {
      // Detached senders may finish the same build concurrently.
      if (!existsSync(join(finalDirectory, 'ready'))) throw error;
    }
    return finalApp;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function sendMacNotification(root: string, payload: { id: string; title: string; body: string; url: string }) {
  try {
    const app = await prepareMacNotifier(root);
    const queue = join(root, 'macos-notifier', 'queue');
    mkdirSync(queue, { recursive: true });
    const request = join(queue, `${payload.id}.json`);
    writeFileSync(request, JSON.stringify(payload), { mode: 0o600 });
    try {
      await execa('open', ['-g', '-a', app, request], { timeout: 10000 });
      for (let attempt = 0; attempt < 300; attempt++) {
        if (existsSync(request + '.result')) return readFileSync(request + '.result', 'utf8');
        await setTimeout(100);
      }
      return 'Notification authorization or delivery timed out; check System Settings → Notifications → TurboBrocolli';
    } finally {
      rmSync(request, { force: true });
      rmSync(request + '.result', { force: true });
    }
  } catch (error) {
    return `macOS notification failed: ${(error as Error).message.slice(0, 300)}`;
  }
}
