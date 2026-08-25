import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';

import { SqsJudgeQueue, type SqsMessageSender } from '../src/interaction-adapters.js';

describe('SqsJudgeQueue', () => {
  it('sends the complete judge job as one JSON message', async () => {
    const send = vi.fn<SqsMessageSender['send']>(async () => ({}));
    const sender: SqsMessageSender = { send };
    const queueUrl = 'https://sqs.ap-northeast-2.amazonaws.com/123456789012/judge';
    const job = {
      kind: 'prepare_review' as const,
      guildId: '1541458098101952522',
      sessionId: '1541459000000000001',
      userId: '1541459000000000003',
      channelId: '1541458116195917935',
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
      DelaySeconds: 1,
    });
  });
});
