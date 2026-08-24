import { TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  pointsForOutcome,
  updateStatsForAbsence,
  updateStatsForJudgment,
  type Judgment,
  type ScorePolicy,
  type UserStats,
} from '@disciplinary-committee/domain';

import { guildPk, sessionPk, submissionSk, userSk, verdictSk } from './keys.js';
import type { SubmissionRecord, VerdictRecord } from './types.js';

export type PersistedSubmission = Pick<SubmissionRecord, 'content' | 'revision' | 'submittedAt'>;

export type FinalizeJudgmentInput = {
  guildId: string;
  sessionId: string;
  userId: string;
  stats: UserStats;
  judgment: Judgment;
  scorePolicy: ScorePolicy;
  finalizedAt: string;
};

export type FinalizeAbsenceInput = Omit<FinalizeJudgmentInput, 'judgment'>;

export class DynamoReviewRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async saveSubmission(input: {
    guildId: string;
    sessionId: string;
    userId: string;
    content: string;
    revision: number;
    submittedAt: string;
    expiresAt: number;
  }): Promise<void> {
    const command: TransactWriteCommandInput = {
      TransactItems: [
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: { PK: guildPk(input.guildId), SK: `SESSION#${input.sessionId}` },
            ConditionExpression: '#state IN (:open, :submitted) AND deadlineAt >= :now',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':open': 'open',
              ':submitted': 'submitted',
              ':now': input.submittedAt,
            },
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              PK: sessionPk(input.sessionId),
              SK: submissionSk(input.userId),
              entityType: 'Submission',
              ...input,
            } satisfies SubmissionRecord,
            ConditionExpression: 'attribute_not_exists(PK) OR revision < :revision',
            ExpressionAttributeValues: { ':revision': input.revision },
          },
        },
      ],
    };
    await this.client.send(new TransactWriteCommand(command));
  }

  public async finalizeJudgment(input: FinalizeJudgmentInput): Promise<void> {
    const nextStats = updateStatsForJudgment(input.stats, input.judgment, input.scorePolicy);
    const verdict: VerdictRecord = {
      PK: sessionPk(input.sessionId),
      SK: verdictSk(input.userId),
      entityType: 'Verdict',
      sessionId: input.sessionId,
      userId: input.userId,
      judgment: input.judgment,
      pointsDelta: pointsForOutcome(input.judgment.outcome, input.scorePolicy),
      finalizedAt: input.finalizedAt,
      reason: 'judgment',
    };
    await this.finalize({
      guildId: input.guildId,
      sessionId: input.sessionId,
      userId: input.userId,
      currentStats: input.stats,
      nextStats,
      verdict,
    });
  }

  public async finalizeAbsence(input: FinalizeAbsenceInput): Promise<void> {
    const nextStats = updateStatsForAbsence(input.stats, input.scorePolicy);
    const verdict: VerdictRecord = {
      PK: sessionPk(input.sessionId),
      SK: verdictSk(input.userId),
      entityType: 'Verdict',
      sessionId: input.sessionId,
      userId: input.userId,
      judgment: null,
      pointsDelta: input.scorePolicy.absent,
      finalizedAt: input.finalizedAt,
      reason: 'absence',
    };
    await this.finalize({
      guildId: input.guildId,
      sessionId: input.sessionId,
      userId: input.userId,
      currentStats: input.stats,
      nextStats,
      verdict,
    });
  }

  private async finalize(input: {
    guildId: string;
    sessionId: string;
    userId: string;
    currentStats: UserStats;
    nextStats: UserStats;
    verdict: VerdictRecord;
  }): Promise<void> {
    const currentStatsVersion = input.currentStats.totalReviews;
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: input.verdict,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                PK: guildPk(input.guildId),
                SK: userSk(input.userId),
                entityType: 'UserStats',
                guildId: input.guildId,
                ...input.nextStats,
              },
              ConditionExpression: 'totalReviews = :currentStatsVersion',
              ExpressionAttributeValues: { ':currentStatsVersion': currentStatsVersion },
            },
          },
        ],
      }),
    );
  }
}
