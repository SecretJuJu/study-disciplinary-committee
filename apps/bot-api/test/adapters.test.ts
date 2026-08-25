import { afterEach, describe, expect, it, vi } from 'vitest';
import { judgeRequest } from '@disciplinary-committee/ai-judge';

import { DiscordRestClient, OpenAIResponsesClient } from '../src/adapters.js';
import { NonRetryableModelError } from '../src/model-errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DiscordRestClient', () => {
  it('uses the bot token only in an authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DiscordRestClient('secret-token');

    await client.sendMessage({ channelId: '123456789012345678', content: '판결문' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/123456789012345678/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bot secret-token' }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('secret-token');
  });

  it('does not treat failed Discord responses as successes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
    const client = new DiscordRestClient('token');
    await expect(
      client.sendMessage({ channelId: '123456789012345678', content: '판결문' }),
    ).rejects.toThrow('Discord API request failed: 429');
  });

  it('classifies a rejected Discord follow-up without exposing its body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('sensitive Discord response', { status: 404 })),
    );
    const client = new DiscordRestClient('token');

    await expect(
      client.editOriginal({
        applicationId: '123456789012345678',
        interactionToken: 'interaction-token',
        content: '판결문',
      }),
    ).rejects.toMatchObject({ diagnosticCode: 'discord_request_rejected', status: 404 });
  });
});

describe('OpenAIResponsesClient', () => {
  it('maps exhausted credit to a safe non-retryable model error', async () => {
    const client = new OpenAIResponsesClient('test-api-key', {
      create: async () =>
        Promise.reject(
          Object.assign(new Error('sensitive billing response'), {
            code: 'credit_balance_exhausted',
          }),
        ),
    });

    await expect(
      client.create(
        judgeRequest({
          submission: { whatStudied: 'test' },
          disciplinaryPoints: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(NonRetryableModelError);
  });

  it('rejects an incomplete model response as retryable', async () => {
    const client = new OpenAIResponsesClient('test-api-key', {
      create: async () => ({ output_text: '', status: 'incomplete' }),
    });

    await expect(
      client.create(
        judgeRequest({
          submission: { whatStudied: 'test' },
          disciplinaryPoints: 0,
        }),
      ),
    ).rejects.toMatchObject({
      diagnosticCode: 'ai_output_incomplete',
    });
  });

  it('classifies an unrecognized OpenAI client failure by stage', async () => {
    const client = new OpenAIResponsesClient('test-api-key', {
      create: async () => Promise.reject(new Error('sensitive connection detail')),
    });

    await expect(
      client.create(
        judgeRequest({
          submission: { whatStudied: 'test' },
          disciplinaryPoints: 0,
        }),
      ),
    ).rejects.toMatchObject({ diagnosticCode: 'ai_request_failed' });
  });
});
