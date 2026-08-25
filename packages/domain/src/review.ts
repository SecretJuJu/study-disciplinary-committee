import { DomainError } from './errors.js';
import type {
  Judgment,
  ReviewOutcome,
  ReviewSessionState,
  ScorePolicy,
  SubmissionInput,
  UserStats,
} from './schemas.js';

const permittedTransitions: Readonly<Record<ReviewSessionState, readonly ReviewSessionState[]>> = {
  scheduled: ['open'],
  open: ['submitted', 'absent_finalized'],
  submitted: ['submitted', 'judging'],
  judging: ['finalized'],
  finalized: [],
  absent_finalized: [],
};

export function transitionReviewSession(
  current: ReviewSessionState,
  next: ReviewSessionState,
): ReviewSessionState {
  if (!permittedTransitions[current].includes(next)) {
    throw new DomainError(`Cannot transition review session from ${current} to ${next}`);
  }

  return next;
}

export function pointsForOutcome(outcome: ReviewOutcome, scorePolicy: ScorePolicy): number {
  switch (outcome) {
    case 'meaningful':
      return 0;
    case 'insufficient':
      return scorePolicy.insufficient;
    case 'meaningless':
      return scorePolicy.meaningless;
  }
}

export function updateStatsForJudgment(
  stats: UserStats,
  judgment: Judgment,
  scorePolicy: ScorePolicy,
): UserStats {
  const nextStreak = judgment.outcome === 'meaningful' ? stats.currentSurvivalStreak + 1 : 0;

  return {
    ...stats,
    totalReviews: stats.totalReviews + 1,
    meaningfulReviews: stats.meaningfulReviews + Number(judgment.outcome === 'meaningful'),
    insufficientReviews: stats.insufficientReviews + Number(judgment.outcome === 'insufficient'),
    meaninglessReviews: stats.meaninglessReviews + Number(judgment.outcome === 'meaningless'),
    disciplinaryPoints: stats.disciplinaryPoints + pointsForOutcome(judgment.outcome, scorePolicy),
    currentSurvivalStreak: nextStreak,
    bestSurvivalStreak: Math.max(stats.bestSurvivalStreak, nextStreak),
  };
}

export function replaceStatsForJudgment(
  stats: UserStats,
  previous: Judgment,
  next: Judgment,
  scorePolicy: ScorePolicy,
): UserStats {
  const outcomeDelta = (outcome: ReviewOutcome): number =>
    Number(next.outcome === outcome) - Number(previous.outcome === outcome);
  return {
    ...stats,
    meaningfulReviews: stats.meaningfulReviews + outcomeDelta('meaningful'),
    insufficientReviews: stats.insufficientReviews + outcomeDelta('insufficient'),
    meaninglessReviews: stats.meaninglessReviews + outcomeDelta('meaningless'),
    disciplinaryPoints:
      stats.disciplinaryPoints -
      pointsForOutcome(previous.outcome, scorePolicy) +
      pointsForOutcome(next.outcome, scorePolicy),
    // 항소는 새 심사 회차가 아니므로 생존 연속 기록은 새로 증가시키지 않는다.
    currentSurvivalStreak: stats.currentSurvivalStreak,
    bestSurvivalStreak: stats.bestSurvivalStreak,
  };
}

export function updateStatsForAbsence(stats: UserStats, scorePolicy: ScorePolicy): UserStats {
  return {
    ...stats,
    totalReviews: stats.totalReviews + 1,
    absentReviews: stats.absentReviews + 1,
    disciplinaryPoints: stats.disciplinaryPoints + scorePolicy.absent,
    currentSurvivalStreak: 0,
  };
}

export function toPromptSubmission(submission: SubmissionInput): string {
  const sections = [`무엇을 공부했습니까?\n${submission.whatStudied}`];

  if (submission.duration !== undefined) {
    sections.push(`얼마나 했습니까?\n${submission.duration}`);
  }

  if (submission.learned !== undefined) {
    sections.push(`무엇을 얻었습니까?\n${submission.learned}`);
  }

  return sections.join('\n\n');
}
