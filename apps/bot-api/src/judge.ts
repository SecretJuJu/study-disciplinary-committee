import { parseJudgment, judgeRequest } from '@disciplinary-committee/ai-judge';
import {
  diagnosticForFailure,
  submissionInputSchema,
  userStatsSchema,
  type ScorePolicy,
} from '@disciplinary-committee/domain';
import type { DynamoReviewRepository } from '@disciplinary-committee/persistence';
import { z } from 'zod';

import type { DiagnosticReporter } from './diagnostics.js';

const judgeJobSchema = z
  .object({
    guildId: z.string().regex(/^\d{17,20}$/),
    sessionId: z.string().min(1).max(128),
    userId: z.string().regex(/^\d{17,20}$/),
    submission: submissionInputSchema,
    stats: userStatsSchema,
    scorePolicy: z.object({
      insufficient: z.number().int(),
      meaningless: z.number().int(),
      absent: z.number().int(),
    }),
    interactionToken: z.string().min(1).max(256),
    applicationId: z.string().regex(/^\d{17,20}$/),
  })
  .strict();
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

export class JudgeWorker {
  public constructor(
    private readonly model: ModelClient,
    private readonly repository: DynamoReviewRepository,
    private readonly discord: DiscordFollowupClient,
    private readonly diagnostics?: DiagnosticReporter,
  ) {}
  public async process(rawJob: unknown, finalizedAt = new Date().toISOString()): Promise<void> {
    let sessionId = 'unknown';
    try {
      const job = judgeJobSchema.parse(rawJob);
      sessionId = job.sessionId;
      const response = await this.model.create(
        judgeRequest({
          submission: job.submission,
          disciplinaryPoints: job.stats.disciplinaryPoints,
        }),
      );
      const judgment = parseJudgment(response.outputText);
      await this.repository.finalizeJudgment({
        guildId: job.guildId,
        sessionId: job.sessionId,
        userId: job.userId,
        stats: job.stats,
        judgment,
        scorePolicy: job.scorePolicy as ScorePolicy,
        finalizedAt,
      });
      await this.discord.editOriginal({
        applicationId: job.applicationId,
        interactionToken: job.interactionToken,
        content: judgment.verdictText,
      });
    } catch (error) {
      await this.reportFailure(error, sessionId);
      throw error;
    }
  }

  private async reportFailure(error: unknown, sessionId: string): Promise<void> {
    if (this.diagnostics === undefined) {
      return;
    }
    try {
      await this.diagnostics.report(
        diagnosticForFailure({ component: 'judge', correlationId: `session:${sessionId}`, error }),
      );
    } catch {
      // 오류 알림 자체의 장애는 원래 작업의 SQS 재시도를 방해하지 않는다.
    }
  }
}
