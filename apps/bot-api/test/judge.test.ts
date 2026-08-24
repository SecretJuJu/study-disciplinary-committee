import { defaultScorePolicy, type UserStats } from '@disciplinary-committee/domain';
import { describe, expect, it } from 'vitest';
import { JudgeWorker } from '../src/judge.js';

const stats: UserStats = {
  userId: '123456789012345678',
  totalReviews: 0,
  meaningfulReviews: 0,
  insufficientReviews: 0,
  meaninglessReviews: 0,
  absentReviews: 0,
  disciplinaryPoints: 0,
  currentSurvivalStreak: 0,
  bestSurvivalStreak: 0,
};
describe('JudgeWorker', () => {
  it('persists before publishing the final Discord message', async () => {
    const calls: string[] = [];
    const worker = new JudgeWorker(
      {
        create: async () => ({
          outputText:
            '{"outcome":"meaningful","rationale":"구체적 활동이 있습니다.","verdictText":"생존으로 처리합니다.","confidence":"high"}',
        }),
      },
      {
        finalizeJudgment: async () => {
          calls.push('persist');
        },
      } as never,
      {
        editOriginal: async () => {
          calls.push('discord');
        },
      },
    );
    await worker.process(
      {
        guildId: '123456789012345678',
        sessionId: 's-1',
        userId: stats.userId,
        submission: { whatStudied: '예제를 구현했습니다.' },
        stats,
        scorePolicy: defaultScorePolicy,
        interactionToken: 'token',
        applicationId: '123456789012345678',
      },
      '2026-08-24T12:00:00.000Z',
    );
    expect(calls).toEqual(['persist', 'discord']);
  });

  it('reports a safe diagnostic and preserves the original failure for retry', async () => {
    const diagnostics: string[] = [];
    const worker = new JudgeWorker(
      { create: async () => Promise.reject(new Error('OPENAI_API_KEY=do-not-send')) },
      {} as never,
      {} as never,
      {
        report: async (event) => {
          diagnostics.push(event.code);
        },
      },
    );

    await expect(
      worker.process({
        guildId: '123456789012345678',
        sessionId: 's-1',
        userId: stats.userId,
        submission: { whatStudied: '예제를 구현했습니다.' },
        stats,
        scorePolicy: defaultScorePolicy,
        interactionToken: 'token',
        applicationId: '123456789012345678',
      }),
    ).rejects.toThrow('OPENAI_API_KEY=do-not-send');

    expect(diagnostics).toEqual(['processing_failed']);
  });
});
