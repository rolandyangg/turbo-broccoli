import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Memory, Label } from './siteMemory.js';

/** Monotone mapping raw → calibrated, fitted with isotonic regression (pool-adjacent-violators). */
interface Curve {
  xs: number[];
  ys: number[];
  n: number;
}
export interface CalibrationModel {
  fitted_at: string;
  global: Curve | null;
  per_type: Record<string, Curve>;
  table: { bin: string; count: number; precision: number | null; mean_raw: number | null }[];
}

const MIN_POINTS = 8;

function isotonic(points: { x: number; y: number }[]): Curve {
  const pts = [...points].sort((a, b) => a.x - b.x);
  // Pool adjacent violators over blocks of (sumY, count, xs).
  const blocks: { sum: number; n: number; xMin: number; xMax: number }[] = [];
  for (const p of pts) {
    blocks.push({ sum: p.y, n: 1, xMin: p.x, xMax: p.x });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!;
      const a = blocks[blocks.length - 1];
      a.sum += b.sum;
      a.n += b.n;
      a.xMax = b.xMax;
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of blocks) {
    xs.push((b.xMin + b.xMax) / 2);
    ys.push(b.sum / b.n);
  }
  return { xs, ys, n: pts.length };
}

function interp(c: Curve, x: number): number {
  if (!c.xs.length) return x;
  if (x <= c.xs[0]) return c.ys[0];
  if (x >= c.xs[c.xs.length - 1]) return c.ys[c.ys.length - 1];
  for (let i = 1; i < c.xs.length; i++) {
    if (x <= c.xs[i]) {
      const t = (x - c.xs[i - 1]) / (c.xs[i] - c.xs[i - 1] || 1);
      return c.ys[i - 1] + t * (c.ys[i] - c.ys[i - 1]);
    }
  }
  return x;
}

export function fitCalibration(labels: Label[]): CalibrationModel {
  const pts = labels.filter((l) => l.raw_confidence != null).map((l) => ({ x: l.raw_confidence!, y: l.label === 'confirmed' ? 1 : 0, type: l.type }));
  const per_type: Record<string, Curve> = {};
  for (const t of new Set(pts.map((p) => p.type))) {
    const tp = pts.filter((p) => p.type === t);
    if (tp.length >= MIN_POINTS) per_type[t] = isotonic(tp);
  }
  const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const table = bins.slice(0, -1).map((lo, i) => {
    const inBin = pts.filter((p) => p.x >= lo && p.x < bins[i + 1]);
    return { bin: `${lo.toFixed(1)}–${Math.min(1, bins[i + 1]).toFixed(1)}`, count: inBin.length, precision: inBin.length ? inBin.filter((p) => p.y).length / inBin.length : null, mean_raw: inBin.length ? inBin.reduce((a, p) => a + p.x, 0) / inBin.length : null };
  });
  return { fitted_at: new Date().toISOString(), global: pts.length >= MIN_POINTS ? isotonic(pts) : null, per_type, table };
}

export function loadCalibration(memory: Memory): CalibrationModel | null {
  const f = join(memory.dir, 'calibration.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}
export function saveCalibration(memory: Memory, m: CalibrationModel) {
  writeFileSync(join(memory.dir, 'calibration.json'), JSON.stringify(m, null, 2));
}

/** Calibrated confidence; shrinks toward the raw score when the curve has few points. */
export function calibrate(model: CalibrationModel | null, type: string, raw: number): { value: number; bucket: string } {
  if (!model) return { value: raw, bucket: 'uncalibrated' };
  const curve = model.per_type[type] ?? model.global;
  if (!curve) return { value: raw, bucket: 'uncalibrated' };
  const w = curve.n / (curve.n + 10);
  return { value: Math.round((w * interp(curve, raw) + (1 - w) * raw) * 100) / 100, bucket: model.per_type[type] ? type : 'global' };
}
