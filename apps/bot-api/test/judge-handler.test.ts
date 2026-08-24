import { describe, expect, it, vi } from 'vitest';

import {
  createCachedAppSecretsLoader,
  createJudgeHandler,
  type JudgeProcessor,
  type SecretValueClient,
} from '../src/judge-handler.js';

describe('judge SQS handler', () => {
  it('returns only failed record identifiers for partial batch retry', async () => {
    const process = vi.fn<JudgeProcessor['process']>(async (rawJob) => {
      if (typeof rawJob === 'string') {
        throw new Error('invalid JSON job');
      }
    });
    const handler = createJudgeHandler(async () => ({ process }));

    const result = await handler({
      Records: [
        { messageId: 'message-ok', body: '{"valid":true}' },
        { messageId: 'message-invalid', body: '{not-json' },
      ],
    });

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-invalid' }],
    });
    expect(process).toHaveBeenNthCalledWith(1, { valid: true });
    expect(process).toHaveBeenNthCalledWith(2, '{not-json');
  });

  it('rejects a non-SQS event at the Zod boundary', async () => {
    const loadProcessor = vi.fn(async () => ({
      process: async () => undefined,
    }));
    const handler = createJudgeHandler(loadProcessor);

    await expect(handler({ Records: [], unexpected: true })).rejects.toThrow();
    expect(loadProcessor).not.toHaveBeenCalled();
  });
});

describe('application secret loader', () => {
  it('strictly validates and caches the Secrets Manager JSON in the container', async () => {
    const send = vi.fn<SecretValueClient['send']>(async () => ({
      SecretString: JSON.stringify({
        OPENAI_API_KEY: 'o'.repeat(20),
        DISCORD_BOT_TOKEN: 'd'.repeat(20),
      }),
    }));
    const load = createCachedAppSecretsLoader({ send }, 'secret-arn');

    const first = await load();
    const second = await load();

    expect(first).toEqual(second);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed or unexpected secret payload', async () => {
    const send = vi
      .fn<SecretValueClient['send']>()
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({
          OPENAI_API_KEY: 'o'.repeat(20),
          DISCORD_BOT_TOKEN: 'd'.repeat(20),
          unexpected: true,
        }),
      })
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({
          OPENAI_API_KEY: 'o'.repeat(20),
          DISCORD_BOT_TOKEN: 'd'.repeat(20),
        }),
      });
    const load = createCachedAppSecretsLoader({ send }, 'secret-arn');

    await expect(load()).rejects.toThrow();
    await expect(load()).resolves.toEqual({
      OPENAI_API_KEY: 'o'.repeat(20),
      DISCORD_BOT_TOKEN: 'd'.repeat(20),
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
