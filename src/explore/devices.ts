import { devices as PW_DEVICES } from 'playwright';
import type { BrowserContextOptions } from 'playwright';
import type { BrowserName } from '../store/schema.js';

/**
 * Real device emulation vs. resizing:
 *  - resize()      = a narrow DESKTOP window: mouse pointer, hover works, desktop UA, DPR 1, meta viewport ignored.
 *  - device profile = the page as that device renders it: touch (pointer: coarse, hover: none), mobile UA,
 *                     device pixel ratio, and <meta viewport> handling (pages without it lay out at 980px).
 * Phone/tablet findings should be confirmed on a device profile; desktop sizes use plain resizing.
 */
export interface DeviceProfile {
  id: string; // stable id used in tools, traces and coverage
  label: string;
  kind: 'phone' | 'tablet' | 'desktop';
  playwright: string | null; // Playwright registry name, null for plain desktop sizes
  viewport: { width: number; height: number };
}

export const DEVICE_PROFILES: DeviceProfile[] = [
  { id: 'iphone-se', label: 'iPhone SE', kind: 'phone', playwright: 'iPhone SE', viewport: { width: 320, height: 568 } },
  { id: 'galaxy-s24', label: 'Galaxy S24', kind: 'phone', playwright: 'Galaxy S24', viewport: { width: 360, height: 780 } },
  { id: 'iphone-15', label: 'iPhone 15', kind: 'phone', playwright: 'iPhone 15', viewport: { width: 393, height: 659 } },
  { id: 'pixel-7', label: 'Pixel 7', kind: 'phone', playwright: 'Pixel 7', viewport: { width: 412, height: 839 } },
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', kind: 'phone', playwright: 'iPhone 15 Pro Max', viewport: { width: 430, height: 739 } },
  { id: 'iphone-15-landscape', label: 'iPhone 15 (landscape)', kind: 'phone', playwright: 'iPhone 15 landscape', viewport: { width: 734, height: 343 } },
  { id: 'ipad-mini', label: 'iPad Mini', kind: 'tablet', playwright: 'iPad Mini', viewport: { width: 768, height: 1024 } },
  { id: 'ipad-pro-11', label: 'iPad Pro 11', kind: 'tablet', playwright: 'iPad Pro 11', viewport: { width: 834, height: 1194 } },
  { id: 'ipad-mini-landscape', label: 'iPad Mini (landscape)', kind: 'tablet', playwright: 'iPad Mini landscape', viewport: { width: 1024, height: 768 } },
  { id: 'laptop-small', label: 'Small laptop 1280×720', kind: 'desktop', playwright: null, viewport: { width: 1280, height: 720 } },
  { id: 'laptop', label: 'Laptop 1366×768', kind: 'desktop', playwright: null, viewport: { width: 1366, height: 768 } },
  { id: 'laptop-hidpi', label: 'MacBook Air 1440×900 @2x', kind: 'desktop', playwright: null, viewport: { width: 1440, height: 900 } },
  { id: 'desktop-fhd', label: 'Desktop 1920×1080', kind: 'desktop', playwright: null, viewport: { width: 1920, height: 1080 } },
  { id: 'desktop-qhd', label: 'Desktop 2560×1440', kind: 'desktop', playwright: null, viewport: { width: 2560, height: 1440 } },
];

export const DEVICE_IDS = DEVICE_PROFILES.map((d) => d.id);

export function deviceById(id: string | null | undefined): DeviceProfile | null {
  if (!id) return null;
  return DEVICE_PROFILES.find((d) => d.id === id || d.label.toLowerCase() === id.toLowerCase()) ?? null;
}

/** Context options for a device in a given engine. Firefox has no isMobile: it gets touch + size + DPR only. */
export function deviceContextOptions(id: string, browser: BrowserName): { options: BrowserContextOptions; notes: string[] } {
  const d = deviceById(id);
  if (!d) throw new Error(`Unknown device "${id}". Known: ${DEVICE_IDS.join(', ')}`);
  const notes: string[] = [];
  if (!d.playwright) {
    const dpr = d.id === 'laptop-hidpi' ? 2 : 1;
    return { options: { viewport: d.viewport, deviceScaleFactor: dpr, isMobile: false, hasTouch: false }, notes };
  }
  const pw = PW_DEVICES[d.playwright];
  const options: BrowserContextOptions = {
    viewport: pw.viewport,
    userAgent: pw.userAgent,
    deviceScaleFactor: pw.deviceScaleFactor,
    isMobile: pw.isMobile,
    hasTouch: pw.hasTouch,
  };
  if (browser === 'firefox') {
    delete options.isMobile;
    notes.push('Firefox cannot emulate mobile viewport handling (isMobile); touch, size, DPR and UA are emulated.');
  }
  return { options, notes };
}

export function describeDevices(): string {
  return DEVICE_PROFILES.map((d) => `${d.id} (${d.label}, ${d.viewport.width}×${d.viewport.height}, ${d.kind})`).join('; ');
}
