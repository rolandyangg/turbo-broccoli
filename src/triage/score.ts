import type { Finding } from '../store/schema.js';
import { calibrate, type CalibrationModel } from '../memory/calibration.js';

/** Weighted blend of the available signals. Reviewer disagreement caps the score. */
export function rawConfidence(b: Finding['confidence_breakdown'], reviewerSaysDefect: boolean | null): number {
  const parts: [number | null, number][] = [
    [b.explorer, 0.25],
    [b.reviewer, 0.4],
    [b.detector, 0.2],
    [b.repro, 0.15],
  ];
  let sum = 0;
  let w = 0;
  for (const [v, wt] of parts) {
    if (v == null) continue;
    sum += v * wt;
    w += wt;
  }
  let raw = w ? sum / w : 0.5;
  if (reviewerSaysDefect === false) raw = Math.min(raw, 0.3);
  if (b.repro === 0) raw = Math.min(raw, 0.35);
  return Math.round(raw * 100) / 100;
}

export function score(f: Finding, model: CalibrationModel | null, reviewerSaysDefect: boolean | null) {
  const raw = rawConfidence(f.confidence_breakdown, reviewerSaysDefect);
  const cal = calibrate(model, f.type, raw);
  f.confidence_breakdown.raw = raw;
  f.confidence_breakdown.calibrated = cal.value;
  f.confidence_breakdown.calibration_bucket = cal.bucket;
  f.confidence = cal.value;
  return f;
}
