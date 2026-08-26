import { describe, expect, it } from 'vitest';

import {
  DomainError,
  defaultDisciplinaryThresholds,
  defaultScorePolicy,
  disciplinaryStatusFor,
  guildSettingsSchema,
  submissionCharacterLimit,
  submissionInputSchema,
  toPromptSubmission,
  transitionReviewSession,
  updateStatsForAbsence,
  updateStatsForJudgment,
} from '../src/index.js';
import type { UserStats } from '../src/index.js';

const stats: UserStats = {
  userId: '123456789012345678',
  totalReviews: 4,
  meaningfulReviews: 3,
  insufficientReviews: 1,
  meaninglessReviews: 0,
  absentReviews: 0,
  disciplinaryPoints: 1,
  currentSurvivalStreak: 3,
  bestSurvivalStreak: 3,
};

describe('review state', () => {
  it('only permits the explicitly defined state transitions', () => {
    expect(transitionReviewSession('open', 'submitted')).toBe('submitted');
    expect(() => transitionReviewSession('open', 'finalized')).toThrow(DomainError);
  });

  it('updates a meaningful judgment without assigning points', () => {
    const result = updateStatsForJudgment(
      stats,
      {
        outcome: 'meaningful',
        rationale: '구체적인 구현 활동이 확인되었습니다.',
        verdictText: '학습 활동을 유의미한 것으로 인정합니다.',
        confidence: 'high',
      },
      defaultScorePolicy,
    );

    expect(result).toMatchObject({
      totalReviews: 5,
      meaningfulReviews: 4,
      disciplinaryPoints: 1,
      currentSurvivalStreak: 4,
      bestSurvivalStreak: 4,
    });
  });

  it('resets survival streak and applies absence points', () => {
    const result = updateStatsForAbsence(stats, defaultScorePolicy);

    expect(result).toMatchObject({
      totalReviews: 5,
      absentReviews: 1,
      disciplinaryPoints: 4,
      currentSurvivalStreak: 0,
    });
  });
});

describe('domain validation', () => {
  it('rejects role changes without a target role', () => {
    const result = guildSettingsSchema.safeParse({
      guildId: '123456789012345678',
      enabled: true,
      timezone: 'Asia/Seoul',
      cadenceMinutes: 1_440,
      submissionWindowMinutes: 30,
      submissionChannelId: '123456789012345678',
      verdictChannelId: '123456789012345678',
      roleChangesEnabled: true,
      scorePolicy: defaultScorePolicy,
      thresholds: defaultDisciplinaryThresholds,
      configVersion: 1,
    });

    expect(result.success).toBe(false);
  });

  it('enforces concise untrusted submissions before AI prompt construction', () => {
    expect(submissionInputSchema.safeParse({ whatStudied: '   ' }).success).toBe(false);
    expect(
      submissionInputSchema.safeParse({ whatStudied: '😀'.repeat(submissionCharacterLimit) })
        .success,
    ).toBe(true);
    expect(
      submissionInputSchema.safeParse({ whatStudied: '😀'.repeat(submissionCharacterLimit + 1) })
        .success,
    ).toBe(false);

    const submission = submissionInputSchema.parse({
      whatStudied: 'Spring 트랜잭션 전파를 구현으로 확인했습니다.',
      learned: 'REQUIRED와 REQUIRES_NEW의 차이를 재현했습니다.',
    });

    expect(toPromptSubmission(submission)).toContain('무엇을 얻었습니까?');
  });

  it('maps points to a status using the configured boundaries', () => {
    expect(disciplinaryStatusFor(0, defaultDisciplinaryThresholds)).toBe('normal');
    expect(disciplinaryStatusFor(3, defaultDisciplinaryThresholds)).toBe('observation');
    expect(disciplinaryStatusFor(5, defaultDisciplinaryThresholds)).toBe('disciplinary');
    expect(disciplinaryStatusFor(8, defaultDisciplinaryThresholds)).toBe('severe_disciplinary');
  });
});
