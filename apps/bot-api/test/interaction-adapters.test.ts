import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { defaultScorePolicy, type UserStats } from '@disciplinary-committee/domain';
import { describe, expect, it, vi } from 'vitest';

import { SqsJudgeQueue, type SqsMessageSender } from '../src/interaction-adapters.js';

describe('SqsJudgeQueue', () => {
  it('sends the complete judge job as one JSON message', async () => {
    const send = vi.fn<SqsMessageSender['send']>(async () => ({}));
    const sender: SqsMessageSender = { send };
    const queueUrl = 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/judge';
    const stats: UserStats = {
      userId: '1541459000000000003',
      totalReviews: 0,
      meaningfulReviews: 0,
      insufficientReviews: 0,
      meaninglessReviews: 0,
      absentReviews: 0,
      disciplinaryPoints: 0,
      currentSurvivalStreak: 0,
      bestSurvivalStreak: 0,
    };
    const job = {
      guildId: '1541458098101952522',
      sessionId: '1541459000000000001',
      userId: stats.userId,
      submission: { whatStudied: 'SQS 경계를 테스트했다.' },
      stats,
      scorePolicy: defaultScorePolicy,
      interactionToken: 'interaction-token-for-test',
      applicationId: '1541457217830522940',
    };

    await new SqsJudgeQueue(sender, queueUrl).enqueue(job);

    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command?.input).toEqual({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(job),
    });
  });
});
