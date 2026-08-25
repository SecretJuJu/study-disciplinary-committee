import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  guildSettingsSchema,
  pointsForOutcome,
  updateStatsForAbsence,
  updateStatsForJudgment,
  userStatsSchema,
  type GuildSettings,
  type Judgment,
  type ScorePolicy,
  type UserStats,
} from '@disciplinary-committee/domain';
import { z } from 'zod';

import {
  guildPk,
  sessionPk,
  sessionSk,
  settingsSk,
  submissionSk,
  userSk,
  verdictSk,
} from './keys.js';
import type {
  GuildSettingsRecord,
  ReviewSessionRecord,
  SubmissionRecord,
  ThreadReviewSession,
  ThreadReviewSessionRecord,
  ThreadReviewState,
  VerdictRecord,
} from './types.js';

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

export type SaveGuildSettingsInput = {
  settings: GuildSettings;
  expectedConfigVersion?: number;
};

export type CreateAdHocReviewInput = {
  guildId: string;
  sessionId: string;
  userId: string;
  content: string;
  submittedAt: string;
  deadlineAt: string;
  expiresAt: number;
  configVersion: number;
};

export type CreateThreadReviewInput = {
  guildId: string;
  sessionId: string;
  ownerId: string;
  channelId: string;
  createdAt: string;
  deadlineAt: string;
  expiresAt: number;
  configVersion: number;
};

export type FinalizeThreadJudgmentInput = FinalizeJudgmentInput;

const snowflakeSchema = z.string().regex(/^\d{17,20}$/);
const threadReviewSessionSchema = z
  .object({
    sessionId: snowflakeSchema,
    guildId: snowflakeSchema,
    ownerId: snowflakeSchema,
    channelId: snowflakeSchema,
    state: z.enum(['draft', 'queued', 'judging', 'finalized', 'cancelled']),
    createdAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    expiresAt: z.number().int().positive(),
    configVersion: z.number().int().positive(),
    anchorMessageId: snowflakeSchema.optional(),
    threadId: snowflakeSchema.optional(),
    leaseUntil: z.string().datetime().optional(),
    claimedAt: z.string().datetime().optional(),
  })
  .strict();

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DynamoReviewRepository {
  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  public async getGuildSettings(guildId: string): Promise<GuildSettings | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: guildPk(guildId), SK: settingsSk() },
        ConsistentRead: true,
      }),
    );

    if (result.Item === undefined) {
      return undefined;
    }
    if (!isRecord(result.Item)) {
      throw new TypeError('Stored guild settings must be an object');
    }

    const { PK, SK, entityType, ...settings } = result.Item;
    if (PK !== guildPk(guildId) || SK !== settingsSk() || entityType !== 'GuildSettings') {
      throw new TypeError('Stored guild settings envelope is invalid');
    }

    return guildSettingsSchema.parse(settings);
  }

  public async saveGuildSettings(input: SaveGuildSettingsInput): Promise<void> {
    const settings = guildSettingsSchema.parse(input.settings);
    const expectedVersion = input.expectedConfigVersion;

    if (expectedVersion === undefined) {
      if (settings.configVersion !== 1) {
        throw new RangeError('Initial guild settings configVersion must be 1');
      }
    } else {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        throw new RangeError('Expected configVersion must be a positive integer');
      }
      if (settings.configVersion !== expectedVersion + 1) {
        throw new RangeError('Updated guild settings configVersion must increment by one');
      }
    }

    const item = {
      PK: guildPk(settings.guildId),
      SK: settingsSk(),
      entityType: 'GuildSettings',
      ...settings,
    } satisfies GuildSettingsRecord;
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression:
          expectedVersion === undefined
            ? 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
            : 'configVersion = :expectedConfigVersion',
        ...(expectedVersion === undefined
          ? {}
          : { ExpressionAttributeValues: { ':expectedConfigVersion': expectedVersion } }),
      }),
    );
  }

  public async getUserStats(guildId: string, userId: string): Promise<UserStats | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: guildPk(guildId), SK: userSk(userId) },
        ConsistentRead: true,
      }),
    );

    if (result.Item === undefined) {
      return undefined;
    }
    if (!isRecord(result.Item)) {
      throw new TypeError('Stored user stats must be an object');
    }

    const { PK, SK, entityType, guildId: storedGuildId, ...stats } = result.Item;
    if (
      PK !== guildPk(guildId) ||
      SK !== userSk(userId) ||
      entityType !== 'UserStats' ||
      storedGuildId !== guildId
    ) {
      throw new TypeError('Stored user stats envelope is invalid');
    }

    return userStatsSchema.parse(stats);
  }

  public async createAdHocReview(input: CreateAdHocReviewInput): Promise<void> {
    const session: ReviewSessionRecord = {
      PK: guildPk(input.guildId),
      SK: sessionSk(input.sessionId),
      entityType: 'ReviewSession',
      sessionId: input.sessionId,
      guildId: input.guildId,
      state: 'submitted',
      deadlineAt: input.deadlineAt,
      expiresAt: input.expiresAt,
      configVersion: input.configVersion,
    };
    const submission: SubmissionRecord = {
      PK: sessionPk(input.sessionId),
      SK: submissionSk(input.userId),
      entityType: 'Submission',
      sessionId: input.sessionId,
      userId: input.userId,
      revision: 1,
      content: input.content,
      submittedAt: input.submittedAt,
      expiresAt: input.expiresAt,
    };

    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: session,
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: submission,
              ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
            },
          },
        ],
      }),
    );
  }

  public async createThreadReview(input: CreateThreadReviewInput): Promise<'created' | 'existing'> {
    const session = threadReviewSessionSchema.parse({ ...input, state: 'draft' });
    const item = {
      PK: guildPk(input.guildId),
      SK: sessionSk(input.sessionId),
      entityType: 'ThreadReviewSession',
      ...session,
    } satisfies ThreadReviewSessionRecord;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
        }),
      );
      return 'created';
    } catch (error) {
      if (!isConditionalFailure(error)) {
        throw error;
      }
      const existing = await this.getThreadReview(input.guildId, input.sessionId);
      if (
        existing?.ownerId === input.ownerId &&
        existing.channelId === input.channelId &&
        existing.configVersion === input.configVersion
      ) {
        return 'existing';
      }
      throw error;
    }
  }

  public async getThreadReview(
    guildId: string,
    sessionId: string,
  ): Promise<ThreadReviewSession | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: guildPk(guildId), SK: sessionSk(sessionId) },
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) {
      return undefined;
    }
    if (!isRecord(result.Item)) {
      throw new TypeError('Stored thread review must be an object');
    }
    const { PK, SK, entityType, ...session } = result.Item;
    if (
      PK !== guildPk(guildId) ||
      SK !== sessionSk(sessionId) ||
      entityType !== 'ThreadReviewSession'
    ) {
      throw new TypeError('Stored thread review envelope is invalid');
    }
    return threadReviewSessionSchema.parse(session);
  }

  public async bindThreadReview(input: {
    guildId: string;
    sessionId: string;
    ownerId: string;
    channelId: string;
    anchorMessageId: string;
    threadId: string;
  }): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: guildPk(input.guildId), SK: sessionSk(input.sessionId) },
        UpdateExpression: 'SET anchorMessageId = :anchor, threadId = :thread',
        ConditionExpression:
          '#state = :draft AND ownerId = :owner AND channelId = :channel AND (attribute_not_exists(anchorMessageId) OR (anchorMessageId = :anchor AND threadId = :thread))',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':draft': 'draft',
          ':owner': input.ownerId,
          ':channel': input.channelId,
          ':anchor': input.anchorMessageId,
          ':thread': input.threadId,
        },
      }),
    );
  }

  public async claimThreadReview(input: {
    guildId: string;
    sessionId: string;
    ownerId: string;
    anchorMessageId: string;
    now: string;
  }): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: guildPk(input.guildId), SK: sessionSk(input.sessionId) },
          UpdateExpression: 'SET #state = :queued, claimedAt = :now',
          ConditionExpression:
            '#state = :draft AND ownerId = :owner AND anchorMessageId = :anchor AND attribute_exists(threadId) AND deadlineAt >= :now',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':draft': 'draft',
            ':queued': 'queued',
            ':owner': input.ownerId,
            ':anchor': input.anchorMessageId,
            ':now': input.now,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) {
        return false;
      }
      throw error;
    }
  }

  public async claimThreadReviewForJudging(input: {
    guildId: string;
    sessionId: string;
    now: string;
    leaseUntil: string;
  }): Promise<ThreadReviewSession | undefined> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { PK: guildPk(input.guildId), SK: sessionSk(input.sessionId) },
          UpdateExpression: 'SET #state = :judging, leaseUntil = :leaseUntil',
          ConditionExpression: '#state = :queued OR (#state = :judging AND leaseUntil < :now)',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':queued': 'queued',
            ':judging': 'judging',
            ':now': input.now,
            ':leaseUntil': input.leaseUntil,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      if (!isRecord(result.Attributes)) {
        throw new TypeError('Claimed thread review attributes are missing');
      }
      const { PK: _pk, SK: _sk, entityType: _entityType, ...session } = result.Attributes;
      return threadReviewSessionSchema.parse(session);
    } catch (error) {
      if (isConditionalFailure(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async reopenThreadReview(input: {
    guildId: string;
    sessionId: string;
    expectedState: Extract<ThreadReviewState, 'queued' | 'judging'>;
  }): Promise<void> {
    await this.transitionThreadReview(input, 'draft', true);
  }

  public async releaseThreadReview(input: { guildId: string; sessionId: string }): Promise<void> {
    await this.transitionThreadReview({ ...input, expectedState: 'judging' }, 'queued', false);
  }

  public async cancelThreadReview(input: { guildId: string; sessionId: string }): Promise<void> {
    await this.transitionThreadReview({ ...input, expectedState: 'judging' }, 'cancelled', true);
  }

  private async transitionThreadReview(
    input: { guildId: string; sessionId: string; expectedState: ThreadReviewState },
    nextState: ThreadReviewState,
    clearClaimedAt: boolean,
  ): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: guildPk(input.guildId), SK: sessionSk(input.sessionId) },
        UpdateExpression: `SET #state = :next REMOVE leaseUntil${clearClaimedAt ? ', claimedAt' : ''}`,
        ConditionExpression: '#state = :expected',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':expected': input.expectedState,
          ':next': nextState,
        },
      }),
    );
  }

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

  public async finalizeThreadJudgment(input: FinalizeThreadJudgmentInput): Promise<void> {
    const nextStats = updateStatsForJudgment(input.stats, input.judgment, input.scorePolicy);
    const currentStatsVersion = input.stats.totalReviews;
    const isFirstReview = currentStatsVersion === 0;
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
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: verdict,
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
                ...nextStats,
              },
              ConditionExpression: isFirstReview
                ? 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
                : 'attribute_exists(PK) AND totalReviews = :currentStatsVersion',
              ...(isFirstReview
                ? {}
                : { ExpressionAttributeValues: { ':currentStatsVersion': currentStatsVersion } }),
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { PK: guildPk(input.guildId), SK: sessionSk(input.sessionId) },
              UpdateExpression: 'SET #state = :finalized REMOVE leaseUntil',
              ConditionExpression: '#state = :judging AND ownerId = :owner',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':judging': 'judging',
                ':finalized': 'finalized',
                ':owner': input.userId,
              },
            },
          },
        ],
      }),
    );
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
    const isFirstReview = currentStatsVersion === 0;
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
              ConditionExpression: isFirstReview
                ? 'attribute_not_exists(PK) AND attribute_not_exists(SK)'
                : 'attribute_exists(PK) AND totalReviews = :currentStatsVersion',
              ...(isFirstReview
                ? {}
                : {
                    ExpressionAttributeValues: {
                      ':currentStatsVersion': currentStatsVersion,
                    },
                  }),
            },
          },
        ],
      }),
    );
  }
}
