import { SendMessageCommand } from '@aws-sdk/client-sqs';

import type { JudgeQueue } from './interaction-service.js';

export type SqsMessageSender = {
  send(command: SendMessageCommand): Promise<unknown>;
};

export class SqsJudgeQueue implements JudgeQueue {
  public constructor(
    private readonly client: SqsMessageSender,
    private readonly queueUrl: string,
  ) {}

  public async enqueue(job: Parameters<JudgeQueue['enqueue']>[0]): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(job),
      }),
    );
  }
}
