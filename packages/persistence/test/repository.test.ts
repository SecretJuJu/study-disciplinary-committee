import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  defaultDisciplinaryThresholds,
  defaultScorePolicy,
  type GuildSettings,
  type UserStats,
} from '@disciplinary-committee/domain';
import { describe, expect, it } from 'vitest';

import { DynamoReviewRepository } from '../src/index.js';

const guildId = '123456789012345678';
const userId = '234567890123456789';

const initialStats: UserStats = {
  userId,
  totalReviews: 0,
  meaningfulReviews: 0,
  insufficientReviews: 0,
  meaninglessReviews: 0,
  absentReviews: 0,
  disciplinaryPoints: 0,
  currentSurvivalStreak: 0,
  bestSurvivalStreak: 0,
};

const existingStats: UserStats = {
  ...initialStats,
  totalReviews: 4,
  meaningfulReviews: 3,
  insufficientReviews: 1,
  currentSurvivalStreak: 3,
  bestSurvivalStreak: 3,
};

const settings: GuildSettings = {
  guildId,
  enabled: true,
  timezone: 'Asia/Seoul',
  cadenceMinutes: 1_440,
  submissionWindowMinutes: 60,
  submissionChannelId: '345678901234567890',
  verdictChannelId: '456789012345678901',
  roleChangesEnabled: false,
  scorePolicy: defaultScorePolicy,
  thresholds: defaultDisciplinaryThresholds,
  configVersion: 1,
};

function repositoryWith(
  input: {
    response?: unknown;
    error?: Error;
    send?: (command: unknown) => Promise<unknown>;
  } = {},
): { repository: DynamoReviewRepository; commands: unknown[] } {
  const commands: unknown[] = [];
  const client = {
    send: async (command: unknown): Promise<unknown> => {
      commands.push(command);
      if (input.send !== undefined) {
        return input.send(command);
      }
      if (input.error !== undefined) {
        throw input.error;
      }
      return input.response ?? {};
    },
  } as unknown as DynamoDBDocumentClient;

  return {
    repository: new DynamoReviewRepository(client, 'committee-dev'),
    commands,
  };
}

describe('DynamoReviewRepository guild settings', () => {
  it('returns validated settings with a strongly consistent read', async () => {
    const { repository, commands } = repositoryWith({
      response: {
        Item: {
          PK: `GUILD#${guildId}`,
          SK: 'SETTINGS',
          entityType: 'GuildSettings',
          ...settings,
        },
      },
    });

    await expect(repository.getGuildSettings(guildId)).resolves.toEqual(settings);
    expect(commands[0]).toBeInstanceOf(GetCommand);
    expect((commands[0] as GetCommand).input).toEqual({
      TableName: 'committee-dev',
      Key: { PK: `GUILD#${guildId}`, SK: 'SETTINGS' },
      ConsistentRead: true,
    });
  });

  it('returns undefined when settings do not exist', async () => {
    const { repository } = repositoryWith();

    await expect(repository.getGuildSettings(guildId)).resolves.toBeUndefined();
  });

  it('rejects malformed settings loaded from DynamoDB', async () => {
    const { timezone: _timezone, ...malformedSettings } = settings;
    const { repository } = repositoryWith({
      response: {
        Item: {
          PK: `GUILD#${guildId}`,
          SK: 'SETTINGS',
          entityType: 'GuildSettings',
          ...malformedSettings,
        },
      },
    });

    await expect(repository.getGuildSettings(guildId)).rejects.toThrow();
  });

  it('creates version 1 only when no settings item exists', async () => {
    const { repository, commands } = repositoryWith();

    await repository.saveGuildSettings({ settings });

    expect(commands[0]).toBeInstanceOf(PutCommand);
    const input = (commands[0] as PutCommand).input;
    expect(input.ConditionExpression).toBe('attribute_not_exists(PK) AND attribute_not_exists(SK)');
    expect(input.ExpressionAttributeValues).toBeUndefined();
    expect(input.Item).toEqual({
      PK: `GUILD#${guildId}`,
      SK: 'SETTINGS',
      entityType: 'GuildSettings',
      ...settings,
    });
  });

  it('updates settings only from the expected version', async () => {
    const { repository, commands } = repositoryWith();
    const updated = { ...settings, configVersion: 2 };

    await repository.saveGuildSettings({ settings: updated, expectedConfigVersion: 1 });

    const input = (commands[0] as PutCommand).input;
    expect(input.ConditionExpression).toBe('configVersion = :expectedConfigVersion');
    expect(input.ExpressionAttributeValues).toEqual({ ':expectedConfigVersion': 1 });
  });

  it('rejects skipped versions before writing', async () => {
    const { repository, commands } = repositoryWith();

    await expect(
      repository.saveGuildSettings({
        settings: { ...settings, configVersion: 3 },
        expectedConfigVersion: 1,
      }),
    ).rejects.toThrow('increment by one');
    expect(commands).toHaveLength(0);
  });

  it('propagates a stale-writer conditional failure', async () => {
    const staleError = new Error('conditional request failed');
    const { repository, commands } = repositoryWith({ error: staleError });

    await expect(
      repository.saveGuildSettings({
        settings: { ...settings, configVersion: 2 },
        expectedConfigVersion: 1,
      }),
    ).rejects.toBe(staleError);
    expect((commands[0] as PutCommand).input.ConditionExpression).toBe(
      'configVersion = :expectedConfigVersion',
    );
  });
});

describe('DynamoReviewRepository stats and ad-hoc review', () => {
  it('returns undefined when user stats do not exist', async () => {
    const { repository, commands } = repositoryWith();

    await expect(repository.getUserStats(guildId, userId)).resolves.toBeUndefined();
    expect((commands[0] as GetCommand).input.Key).toEqual({
      PK: `GUILD#${guildId}`,
      SK: `USER#${userId}`,
    });
  });

  it('validates user stats loaded from DynamoDB', async () => {
    const { repository } = repositoryWith({
      response: {
        Item: {
          PK: `GUILD#${guildId}`,
          SK: `USER#${userId}`,
          entityType: 'UserStats',
          guildId,
          ...existingStats,
        },
      },
    });

    await expect(repository.getUserStats(guildId, userId)).resolves.toEqual(existingStats);
  });

  it('rejects stats stored under a mismatched guild envelope', async () => {
    const { repository } = repositoryWith({
      response: {
        Item: {
          PK: `GUILD#${guildId}`,
          SK: `USER#${userId}`,
          entityType: 'UserStats',
          guildId: '999999999999999999',
          ...existingStats,
        },
      },
    });

    await expect(repository.getUserStats(guildId, userId)).rejects.toThrow(
      'Stored user stats envelope is invalid',
    );
  });

  it('atomically creates an ad-hoc session and its first submission', async () => {
    const { repository, commands } = repositoryWith();

    await repository.createAdHocReview({
      guildId,
      sessionId: '1541459000000000000',
      userId,
      content: '{"whatStudied":"DynamoDB transactions"}',
      submittedAt: '2026-08-24T16:00:00.000Z',
      deadlineAt: '2026-08-24T16:15:00.000Z',
      expiresAt: 1_782_402_100,
      configVersion: 2,
    });

    expect(commands[0]).toBeInstanceOf(TransactWriteCommand);
    const items = (commands[0] as TransactWriteCommand).input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items?.[0]?.Put).toMatchObject({
      Item: {
        PK: `GUILD#${guildId}`,
        SK: 'SESSION#1541459000000000000',
        entityType: 'ReviewSession',
        state: 'submitted',
        deadlineAt: '2026-08-24T16:15:00.000Z',
        expiresAt: 1_782_402_100,
      },
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    });
    expect(items?.[1]?.Put).toMatchObject({
      Item: {
        PK: 'SESSION#1541459000000000000',
        SK: `SUBMISSION#${userId}`,
        entityType: 'Submission',
        revision: 1,
        expiresAt: 1_782_402_100,
      },
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    });
  });

  it('allows the first verdict to create stats but keeps verdict idempotency', async () => {
    const { repository, commands } = repositoryWith();

    await repository.finalizeJudgment({
      guildId,
      sessionId: '1541459000000000000',
      userId,
      stats: initialStats,
      scorePolicy: defaultScorePolicy,
      finalizedAt: '2026-08-24T16:01:00.000Z',
      judgment: {
        outcome: 'meaningful',
        rationale: '구체적인 활동이 확인되었습니다.',
        verdictText: '생존으로 처리합니다.',
        confidence: 'high',
      },
    });

    const items = (commands[0] as TransactWriteCommand).input.TransactItems;
    expect(items?.[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(items?.[1]?.Put?.ConditionExpression).toBe(
      'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    );
    expect(items?.[1]?.Put?.ExpressionAttributeValues).toBeUndefined();
  });

  it('requires an exact existing stats version after the first verdict', async () => {
    const { repository, commands } = repositoryWith();

    await repository.finalizeJudgment({
      guildId,
      sessionId: '1541459000000000001',
      userId,
      stats: existingStats,
      scorePolicy: defaultScorePolicy,
      finalizedAt: '2026-08-24T16:01:00.000Z',
      judgment: {
        outcome: 'insufficient',
        rationale: '구체성이 부족합니다.',
        verdictText: '분발이 필요합니다.',
        confidence: 'medium',
      },
    });

    const statsPut = (commands[0] as TransactWriteCommand).input.TransactItems?.[1]?.Put;
    expect(statsPut?.ConditionExpression).toBe(
      'attribute_exists(PK) AND totalReviews = :currentStatsVersion',
    );
    expect(statsPut?.ExpressionAttributeValues).toEqual({ ':currentStatsVersion': 4 });
  });

  it('propagates duplicate verdict or stale stats transaction failures', async () => {
    const transactionError = new Error('transaction canceled');
    const { repository } = repositoryWith({ error: transactionError });

    await expect(
      repository.finalizeAbsence({
        guildId,
        sessionId: '1541459000000000002',
        userId,
        stats: existingStats,
        scorePolicy: defaultScorePolicy,
        finalizedAt: '2026-08-24T16:01:00.000Z',
      }),
    ).rejects.toBe(transactionError);
  });
});

describe('DynamoReviewRepository thread review state machine', () => {
  const sessionId = '1541459000000000000';
  const createdAt = '2026-08-25T00:00:00.000Z';
  const deadlineAt = '2026-08-25T00:30:00.000Z';
  const expiresAt = 1_795_392_000;

  it('creates a draft session idempotency boundary without a submission body', async () => {
    const { repository, commands } = repositoryWith();

    await expect(
      repository.createThreadReview({
        guildId,
        sessionId,
        ownerId: userId,
        channelId: settings.submissionChannelId,
        createdAt,
        deadlineAt,
        expiresAt,
        configVersion: settings.configVersion,
      }),
    ).resolves.toBe('created');

    expect(commands[0]).toBeInstanceOf(PutCommand);
    expect((commands[0] as PutCommand).input).toMatchObject({
      Item: {
        PK: `GUILD#${guildId}`,
        SK: `SESSION#${sessionId}`,
        entityType: 'ThreadReviewSession',
        state: 'draft',
        ownerId: userId,
      },
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    });
  });

  it('treats an exact existing interaction session as an idempotent create retry', async () => {
    let callCount = 0;
    const conflict = Object.assign(new Error('duplicate'), {
      name: 'ConditionalCheckFailedException',
    });
    const { repository } = repositoryWith({
      send: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw conflict;
        }
        return {
          Item: {
            PK: `GUILD#${guildId}`,
            SK: `SESSION#${sessionId}`,
            entityType: 'ThreadReviewSession',
            sessionId,
            guildId,
            ownerId: userId,
            channelId: settings.submissionChannelId,
            state: 'draft',
            createdAt,
            deadlineAt,
            expiresAt,
            configVersion: settings.configVersion,
          },
        };
      },
    });

    await expect(
      repository.createThreadReview({
        guildId,
        sessionId,
        ownerId: userId,
        channelId: settings.submissionChannelId,
        createdAt,
        deadlineAt,
        expiresAt,
        configVersion: settings.configVersion,
      }),
    ).resolves.toBe('existing');
  });

  it('binds the stable anchor/thread and claims the button only before the deadline', async () => {
    const anchorMessageId = '1541459000000000008';
    const threadId = '1541459000000000009';
    const { repository, commands } = repositoryWith({
      send: async () =>
        commands.length === 1
          ? {}
          : {
              Attributes: {
                PK: `GUILD#${guildId}`,
                SK: `SESSION#${sessionId}`,
                entityType: 'ThreadReviewSession',
                sessionId,
                guildId,
                ownerId: userId,
                channelId: settings.submissionChannelId,
                state: 'queued',
                createdAt,
                deadlineAt,
                expiresAt,
                configVersion: settings.configVersion,
                anchorMessageId,
                threadId,
                claimedAt: createdAt,
              },
            },
    });
    await repository.bindThreadReview({
      guildId,
      sessionId,
      ownerId: userId,
      channelId: settings.submissionChannelId,
      anchorMessageId,
      threadId,
    });
    await expect(
      repository.claimThreadReview({
        guildId,
        sessionId,
        ownerId: userId,
        channelId: settings.submissionChannelId,
        anchorMessageId,
        now: createdAt,
      }),
    ).resolves.toMatchObject({ state: 'queued', claimedAt: createdAt });

    const bind = (commands[0] as UpdateCommand).input;
    const claim = (commands[1] as UpdateCommand).input;
    expect(bind.ConditionExpression).toContain('anchorMessageId = :anchor');
    expect(claim.ConditionExpression).toContain('deadlineAt >= :now');
    expect(claim.ConditionExpression).toContain('(channelId = :channel OR threadId = :channel)');
    expect(claim.ExpressionAttributeValues).toMatchObject({
      ':draft': 'draft',
      ':queued': 'queued',
      ':now': createdAt,
    });
  });

  it('returns undefined for a duplicate conditional button claim', async () => {
    const conflict = Object.assign(new Error('duplicate'), {
      name: 'ConditionalCheckFailedException',
    });
    const { repository } = repositoryWith({ error: conflict });

    await expect(
      repository.claimThreadReview({
        guildId,
        sessionId,
        ownerId: userId,
        channelId: settings.submissionChannelId,
        anchorMessageId: '1541459000000000008',
        now: createdAt,
      }),
    ).resolves.toBeUndefined();
  });

  it('claims an appeal only once per interaction request id', async () => {
    const requestId = '1541459000000000010';
    const { repository, commands } = repositoryWith({
      response: {
        Attributes: {
          PK: `GUILD#${guildId}`,
          SK: `SESSION#${sessionId}`,
          entityType: 'ThreadReviewSession',
          sessionId,
          guildId,
          ownerId: userId,
          channelId: settings.submissionChannelId,
          state: 'queued',
          createdAt,
          deadlineAt,
          expiresAt,
          configVersion: settings.configVersion,
          anchorMessageId: '1541459000000000008',
          threadId: '1541459000000000009',
          claimedAt: createdAt,
          initialClaimedAt: createdAt,
          appealFromAt: createdAt,
          pendingAction: 'appeal',
          pendingRequestId: requestId,
          appealsUsed: 0,
        },
      },
    });

    await expect(
      repository.claimThreadAppeal({
        guildId,
        sessionId,
        ownerId: userId,
        channelId: settings.submissionChannelId,
        anchorMessageId: '1541459000000000008',
        now: createdAt,
        appealFromAt: createdAt,
        initialClaimedAt: createdAt,
        requestId,
      }),
    ).resolves.toMatchObject({ pendingAction: 'appeal', pendingRequestId: requestId });
    expect((commands[0] as UpdateCommand).input.ConditionExpression).toContain(
      'lastProcessedRequestId <> :requestId',
    );
  });

  it('claims a queued job with a retry lease and parses the strict returned record', async () => {
    const { repository, commands } = repositoryWith({
      response: {
        Attributes: {
          PK: `GUILD#${guildId}`,
          SK: `SESSION#${sessionId}`,
          entityType: 'ThreadReviewSession',
          sessionId,
          guildId,
          ownerId: userId,
          channelId: settings.submissionChannelId,
          state: 'judging',
          createdAt,
          deadlineAt,
          expiresAt,
          configVersion: settings.configVersion,
          anchorMessageId: '1541459000000000008',
          threadId: '1541459000000000009',
          leaseUntil: '2026-08-25T00:08:00.000Z',
        },
      },
    });

    await expect(
      repository.claimThreadReviewForJudging({
        guildId,
        sessionId,
        now: createdAt,
        leaseUntil: '2026-08-25T00:08:00.000Z',
      }),
    ).resolves.toMatchObject({ state: 'judging', ownerId: userId });
    expect((commands[0] as UpdateCommand).input.ConditionExpression).toContain('leaseUntil < :now');
  });

  it('preserves the button cutoff across retryable worker releases', async () => {
    const { repository, commands } = repositoryWith();

    await repository.releaseThreadReview({ guildId, sessionId });
    await repository.reopenThreadReview({
      guildId,
      sessionId,
      expectedState: 'queued',
    });

    expect((commands[0] as UpdateCommand).input.UpdateExpression).toBe(
      'SET #state = :next REMOVE leaseUntil',
    );
    expect((commands[1] as UpdateCommand).input.UpdateExpression).toBe(
      'SET #state = :next REMOVE leaseUntil, claimedAt, initialClaimedAt, appealFromAt, pendingAction, pendingRequestId',
    );
  });

  it('marks settings-invalidated reviews as cancelled', async () => {
    const { repository, commands } = repositoryWith();

    await repository.cancelThreadReview({ guildId, sessionId });

    expect((commands[0] as UpdateCommand).input).toMatchObject({
      UpdateExpression:
        'SET #state = :next REMOVE leaseUntil, claimedAt, initialClaimedAt, appealFromAt, pendingAction, pendingRequestId',
      ConditionExpression: '#state = :expected',
      ExpressionAttributeValues: {
        ':expected': 'judging',
        ':next': 'cancelled',
      },
    });
  });

  it('finalizes verdict, stats, and session state in one transaction', async () => {
    const { repository, commands } = repositoryWith();

    await repository.finalizeThreadJudgment({
      guildId,
      sessionId,
      userId,
      stats: initialStats,
      scorePolicy: defaultScorePolicy,
      finalizedAt: '2026-08-25T00:01:00.000Z',
      judgment: {
        outcome: 'meaningful',
        rationale: '구체적인 학습 활동이 있습니다.',
        verdictText: '유의미한 학습입니다.',
        confidence: 'high',
      },
    });

    const items = (commands[0] as TransactWriteCommand).input.TransactItems;
    expect(items).toHaveLength(3);
    expect(items?.[2]?.Update).toMatchObject({
      Key: { PK: `GUILD#${guildId}`, SK: `SESSION#${sessionId}` },
      ConditionExpression: '#state = :judging AND ownerId = :owner',
      UpdateExpression:
        'SET #state = :finalized, appealsUsed = if_not_exists(appealsUsed, :zero) REMOVE leaseUntil, pendingAction, appealFromAt',
    });
  });

  it('replaces the current verdict and stats while preserving an immutable appeal record', async () => {
    const { repository, commands } = repositoryWith();
    const previousJudgment = {
      outcome: 'meaningful' as const,
      rationale: '기존 근거',
      verdictText: '기존 결론',
      confidence: 'medium' as const,
    };
    await repository.finalizeThreadAppeal({
      guildId,
      sessionId,
      userId,
      stats: { ...initialStats, totalReviews: 1, meaningfulReviews: 1 },
      previousVerdict: {
        judgment: previousJudgment,
        pointsDelta: 0,
        finalizedAt: '2026-08-25T00:01:00.000Z',
        revision: 0,
      },
      judgment: {
        outcome: 'meaningless',
        rationale: '새 자료를 반영한 근거',
        verdictText: '항소 후 결론',
        confidence: 'high',
      },
      scorePolicy: defaultScorePolicy,
      finalizedAt: '2026-08-25T00:05:00.000Z',
      expiresAt,
      expectedAppealsUsed: 0,
      requestId: '1541459000000000010',
    });

    const items = (commands[0] as TransactWriteCommand).input.TransactItems;
    expect(items).toHaveLength(4);
    expect(items?.[0]?.Put?.Item).toMatchObject({
      SK: 'APPEAL#01',
      appealNumber: 1,
      previousJudgment,
    });
    expect(items?.[1]?.Put?.Item).toMatchObject({ SK: `VERDICT#${userId}`, revision: 1 });
    expect(items?.[2]?.Put?.Item).toMatchObject({
      totalReviews: 1,
      meaningfulReviews: 0,
      meaninglessReviews: 1,
      disciplinaryPoints: defaultScorePolicy.meaningless,
    });
    expect(items?.[3]?.Update?.UpdateExpression).toContain('appealsUsed = :nextAppealsUsed');
  });
});
