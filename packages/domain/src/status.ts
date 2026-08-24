import type { DisciplinaryStatus, DisciplinaryThresholds } from './schemas.js';

export function disciplinaryStatusFor(
  points: number,
  thresholds: DisciplinaryThresholds,
): DisciplinaryStatus {
  if (points >= thresholds.severeAt) {
    return 'severe_disciplinary';
  }

  if (points >= thresholds.disciplinaryAt) {
    return 'disciplinary';
  }

  if (points >= thresholds.observationAt) {
    return 'observation';
  }

  return 'normal';
}

export function survivalRate(stats: { totalReviews: number; meaningfulReviews: number }): number {
  if (stats.totalReviews === 0) {
    return 0;
  }

  return Number(((stats.meaningfulReviews / stats.totalReviews) * 100).toFixed(1));
}
