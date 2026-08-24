import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defaultScorePolicy, type UserStats } from '@disciplinary-committee/domain';
import { describe, expect, it } from 'vitest';

import { DynamoReviewRepository } from '../src/index.js';

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

describe('DynamoReviewRepository', () => {
  it('finalizes a verdict and stats in one conditional transaction', async () => {
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown): Promise<undefined> => {
        commands.push(command);
        return undefined;
      },
    } as unknown as DynamoDBDocumentClient;
    const repository = new DynamoReviewRepository(client, 'committee-dev');

    await repository.finalizeJudgment({
      guildId: '123456789012345678',
      sessionId: 'session-1',
      userId: stats.userId,
      stats,
      scorePolicy: defaultScorePolicy,
      finalizedAt: '2026-08-24T11:00:00.000Z',
      judgment: {
        outcome: 'meaningful',
        rationale: '구체적인 활동이 확인되었습니다.',
        verdictText: '생존으로 처리합니다.',
        confidence: 'high',
      },
    });

    const command = commands[0];
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const input = (command as TransactWriteCommand).input;
    expect(input.TransactItems).toHaveLength(2);
    expect(input.TransactItems?.[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(input.TransactItems?.[1]?.Put?.ConditionExpression).toBe(
      'totalReviews = :currentStatsVersion',
    );
  });
});
