import { defaultScorePolicy, type Judgment, type UserStats } from '@disciplinary-committee/domain';
import { describe, expect, it, vi } from 'vitest';

import { JudgeWorker, type JudgeJob, type JudgeRepository } from '../src/judge.js';
import { creditExhaustedMessage, NonRetryableModelError } from '../src/model-errors.js';

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
const judgment: Judgment = {
  outcome: 'meaningful',
  rationale: '구체적 활동이 있습니다.',
  verdictText: '생존으로 처리합니다.',
  confidence: 'high',
};
const job: JudgeJob = {
  guildId: '123456789012345678',
  sessionId: 's-1',
  userId: stats.userId,
  submission: { whatStudied: '예제를 구현했습니다.' },
  stats,
  scorePolicy: defaultScorePolicy,
  interactionToken: 'token',
  applicationId: '123456789012345678',
};

function model() {
  return {
    create: vi.fn(async () => ({ outputText: JSON.stringify(judgment) })),
  };
}

function repository(overrides: Partial<JudgeRepository> = {}): JudgeRepository {
  return {
    getUserStats: async () => undefined,
    getFinalizedJudgment: async () => undefined,
    finalizeJudgment: async () => undefined,
    ...overrides,
  };
}

describe('JudgeWorker', () => {
  it('uses current stats and persists before publishing the final Discord message', async () => {
    const calls: string[] = [];
    const latestStats = { ...stats, totalReviews: 1, disciplinaryPoints: 2 };
    const worker = new JudgeWorker(
      model(),
      repository({
        getUserStats: async () => latestStats,
        finalizeJudgment: async (input) => {
          expect(input.stats).toEqual(latestStats);
          calls.push('persist');
        },
      }),
      {
        editOriginal: async () => {
          calls.push('discord');
        },
      },
    );

    await worker.process(job, '2026-08-24T12:00:00.000Z');

    expect(calls).toEqual(['persist', 'discord']);
  });

  it('publishes an existing verdict without invoking the model or persisting again', async () => {
    const modelClient = model();
    const finalizeJudgment = vi.fn<JudgeRepository['finalizeJudgment']>();
    const editOriginal = vi.fn(async () => undefined);
    const worker = new JudgeWorker(
      modelClient,
      repository({
        getFinalizedJudgment: async () => judgment,
        finalizeJudgment,
      }),
      { editOriginal },
    );

    await worker.process(job);

    expect(modelClient.create).not.toHaveBeenCalled();
    expect(finalizeJudgment).not.toHaveBeenCalled();
    expect(editOriginal).toHaveBeenCalledWith(
      expect.objectContaining({ content: judgment.verdictText }),
    );
  });

  it('retries persistence once with refreshed stats after a concurrent stats update', async () => {
    const refreshedStats = { ...stats, totalReviews: 1, meaningfulReviews: 1 };
    const finalizeJudgment = vi
      .fn<JudgeRepository['finalizeJudgment']>()
      .mockRejectedValueOnce(
        Object.assign(new Error('conflict'), {
          name: 'TransactionCanceledException',
        }),
      )
      .mockResolvedValueOnce(undefined);
    const getUserStats = vi
      .fn<JudgeRepository['getUserStats']>()
      .mockResolvedValueOnce(stats)
      .mockResolvedValueOnce(refreshedStats);
    const worker = new JudgeWorker(model(), repository({ getUserStats, finalizeJudgment }), {
      editOriginal: async () => undefined,
    });

    await worker.process(job);

    expect(finalizeJudgment).toHaveBeenCalledTimes(2);
    expect(finalizeJudgment.mock.calls[1]?.[0].stats).toEqual(refreshedStats);
  });

  it('can finish a retry after Discord failed following a durable verdict', async () => {
    let persisted: Judgment | undefined;
    const modelClient = model();
    const repo = repository({
      getFinalizedJudgment: async () => persisted,
      finalizeJudgment: async (input) => {
        persisted = input.judgment;
      },
    });
    const editOriginal = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('Discord unavailable'))
      .mockResolvedValueOnce(undefined);
    const worker = new JudgeWorker(modelClient, repo, { editOriginal });

    await expect(worker.process(job)).rejects.toThrow('Discord unavailable');
    await worker.process(job);

    expect(modelClient.create).toHaveBeenCalledTimes(1);
    expect(editOriginal).toHaveBeenCalledTimes(2);
  });

  it('reports a safe diagnostic and preserves the original failure for retry', async () => {
    const diagnostics: string[] = [];
    const worker = new JudgeWorker(
      {
        create: async () => Promise.reject(new Error('OPENAI_API_KEY=do-not-send')),
      },
      repository(),
      { editOriginal: async () => undefined },
      {
        report: async (event) => {
          diagnostics.push(event.code);
        },
      },
    );

    await expect(worker.process(job)).rejects.toThrow('OPENAI_API_KEY=do-not-send');
    expect(diagnostics).toEqual(['processing_failed']);
  });

  it('classifies invalid structured output and keeps the job retryable', async () => {
    const diagnostics: string[] = [];
    const worker = new JudgeWorker(
      { create: async () => ({ outputText: '' }) },
      repository(),
      { editOriginal: async () => undefined },
      {
        report: async (event) => {
          diagnostics.push(event.code);
        },
      },
    );

    await expect(worker.process(job)).rejects.toMatchObject({
      diagnosticCode: 'ai_output_invalid',
    });
    expect(diagnostics).toEqual(['ai_output_invalid']);
  });

  it('ends the deferred response without retrying when AI credit is exhausted', async () => {
    const diagnostics: string[] = [];
    const finalizeJudgment = vi.fn<JudgeRepository['finalizeJudgment']>();
    const editOriginal = vi.fn(async () => undefined);
    const worker = new JudgeWorker(
      {
        create: async () => Promise.reject(new NonRetryableModelError()),
      },
      repository({ finalizeJudgment }),
      { editOriginal },
      {
        report: async (event) => {
          diagnostics.push(event.code);
        },
      },
    );

    await expect(worker.process(job)).resolves.toBeUndefined();

    expect(finalizeJudgment).not.toHaveBeenCalled();
    expect(editOriginal).toHaveBeenCalledWith({
      applicationId: job.applicationId,
      interactionToken: job.interactionToken,
      content: creditExhaustedMessage,
    });
    expect(diagnostics).toEqual(['ai_credit_exhausted']);
  });

  it('rejects a job whose embedded stats belong to another user', async () => {
    const worker = new JudgeWorker(model(), repository(), {
      editOriginal: async () => undefined,
    });

    await expect(
      worker.process({
        ...job,
        stats: { ...stats, userId: '987654321098765432' },
      }),
    ).rejects.toThrow();
  });
});
