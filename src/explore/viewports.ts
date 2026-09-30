import type { Config } from '../config.js';

export const PHONE_WIDTHS = [320, 360, 375, 390, 414];
export const TABLET_WIDTHS = [600, 768, 820, 1024];
export const DESKTOP_WIDTHS = [1280, 1440, 1920];

export function matrix(cfg: Config): { width: number; height: number }[] {
  return cfg.viewports.widths.flatMap((w) => cfg.viewports.heights.map((h) => ({ width: w, height: h })));
}

/** Widths around each breakpoint (N-1, N, N+1) for breakpoint-edge probing. */
export function breakpointProbes(breakpoints: number[]): number[] {
  return [...new Set(breakpoints.flatMap((b) => [b - 1, b, b + 1]).filter((w) => w >= 280 && w <= 2560))].sort((a, b) => a - b);
}

export const VARIANT_PRESETS = {
  dark: { colorScheme: 'dark' as const },
  bigText: { fontScale: 2 },
  zoom200: { zoom: 2 },
  zoom50: { zoom: 0.5 },
  retina: { dpr: 2 },
  reducedMotion: { reducedMotion: true },
};
