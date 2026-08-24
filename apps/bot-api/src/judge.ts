import { parseJudgment, judgeRequest } from '@disciplinary-committee/ai-judge';
import {
  diagnosticForFailure,
  scorePolicySchema,
  submissionInputSchema,
  userStatsSchema,
  type Judgment,
  type UserStats,
} from '@disciplinary-committee/domain';
import type { FinalizeJudgmentInput } from '@disciplinary-committee/persistence';
import { z } from 'zod';

import type { DiagnosticReporter } from './diagnostics.js';

const judgeJobSchema = z
  .object({
    guildId: z.string().regex(/^\d{17,20}$/),
    sessionId: z.string().min(1).max(128),
    userId: z.string().regex(/^\d{17,20}$/),
    submission: submissionInputSchema,
    stats: userStatsSchema,
    scorePolicy: scorePolicySchema,
    interactionToken: z.string().min(1).max(256),
    applicationId: z.string().regex(/^\d{17,20}$/),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.stats.userId !== job.userId) {
      context.addIssue({
        code: 'custom',
        message: 'stats.userId must match userId',
        path: ['stats', 'userId'],
      });
    }
  });
export type JudgeJob = z.infer<typeof judgeJobSchema>;

export type ModelClient = {
  create(request: ReturnType<typeof judgeRequest>): Promise<{ outputText: string }>;
};
export type DiscordFollowupClient = {
  editOriginal(input: {
    applicationId: string;
    interactionToken: string;
    content: string;
  }): Promise<void>;
};

export type JudgeRepository = {
  getUserStats(guildId: string, userId: string): Promise<UserStats | undefined>;
  getFinalizedJudgment(sessionId: string, userId: string): Promise<Judgment | undefined>;
  finalizeJudgment(input: FinalizeJudgmentInput): Promise<void>;
};

function isTransactionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'TransactionCanceledException';
}

export class JudgeWorker {
  public constructor(
    private readonly model: ModelClient,
    private readonly repository: JudgeRepository,
    private readonly discord: DiscordFollowupClient,
    private readonly diagnostics?: DiagnosticReporter,
  ) {}
  public async process(rawJob: unknown, finalizedAt = new Date().toISOString()): Promise<void> {
    let sessionId = 'unknown';
    try {
      const job = judgeJobSchema.parse(rawJob);
      sessionId = job.sessionId;
      const existingJudgment = await this.repository.getFinalizedJudgment(
        job.sessionId,
        job.userId,
      );
      if (existingJudgment !== undefined) {
        await this.publish(job, existingJudgment);
        return;
      }

      const latestStats =
        (await this.repository.getUserStats(job.guildId, job.userId)) ?? job.stats;
      const response = await this.model.create(
        judgeRequest({
          submission: job.submission,
          disciplinaryPoints: latestStats.disciplinaryPoints,
        }),
      );
      const judgment = parseJudgment(response.outputText);
      const finalizedJudgment = await this.finalize(job, judgment, latestStats, finalizedAt);
      await this.publish(job, finalizedJudgment);
    } catch (error) {
      await this.reportFailure(error, sessionId);
      throw error;
    }
  }

  private async finalize(
    job: JudgeJob,
    judgment: Judgment,
    stats: UserStats,
    finalizedAt: string,
  ): Promise<Judgment> {
    const persist = async (currentStats: UserStats): Promise<void> =>
      this.repository.finalizeJudgment({
        guildId: job.guildId,
        sessionId: job.sessionId,
        userId: job.userId,
        stats: currentStats,
        judgment,
        scorePolicy: job.scorePolicy,
        finalizedAt,
      });

    try {
      await persist(stats);
      return judgment;
    } catch (error) {
      if (!isTransactionConflict(error)) {
        throw error;
      }

      const concurrentlyFinalized = await this.repository.getFinalizedJudgment(
        job.sessionId,
        job.userId,
      );
      if (concurrentlyFinalized !== undefined) {
        return concurrentlyFinalized;
      }

      const refreshedStats = await this.repository.getUserStats(job.guildId, job.userId);
      if (refreshedStats === undefined) {
        throw error;
      }
      await persist(refreshedStats);
      return judgment;
    }
  }

  private async publish(job: JudgeJob, judgment: Judgment): Promise<void> {
    await this.discord.editOriginal({
      applicationId: job.applicationId,
      interactionToken: job.interactionToken,
      content: judgment.verdictText,
    });
  }

  private async reportFailure(error: unknown, sessionId: string): Promise<void> {
    if (this.diagnostics === undefined) {
      return;
    }
    try {
      await this.diagnostics.report(
        diagnosticForFailure({
          component: 'judge',
          correlationId: `session:${sessionId}`,
          error,
        }),
      );
    } catch {
      // 오류 알림 자체의 장애는 원래 작업의 SQS 재시도를 방해하지 않는다.
    }
  }
}
