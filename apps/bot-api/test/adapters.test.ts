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

  it('resolves the original interaction without putting the webhook token in headers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: '123456789012345679', channel_id: '123456789012345678' }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new DiscordRestClient('bot-token');

    await expect(
      client.getOriginalMessage({
        applicationId: '123456789012345677',
        interactionToken: 'webhook-token',
      }),
    ).resolves.toEqual({ id: '123456789012345679', channelId: '123456789012345678' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/webhooks/123456789012345677/webhook-token/messages/@original',
      expect.objectContaining({ method: 'GET', headers: { 'content-type': 'application/json' } }),
    );
  });

  it('creates a public thread once and reuses an existing source-message thread', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '123456789012345679' }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '123456789012345679' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new DiscordRestClient('bot-token');
    const input = {
      channelId: '123456789012345678',
      messageId: '123456789012345679',
      name: '학습-심사-테스트',
    };

    await expect(client.ensurePublicThread(input)).resolves.toEqual({ id: input.messageId });
    await expect(client.ensurePublicThread(input)).resolves.toEqual({ id: input.messageId });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `https://discord.com/api/v10/channels/${input.channelId}/messages/${input.messageId}/threads`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns a non-retryable setup result when Discord denies thread creation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DiscordRestClient('bot-token');

    await expect(
      client.ensurePublicThread({
        channelId: '123456789012345678',
        messageId: '123456789012345679',
        name: '학습-심사-테스트',
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps unknown-message thread setup failures retryable', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DiscordRestClient('bot-token');

    await expect(
      client.ensurePublicThread({
        channelId: '123456789012345678',
        messageId: '123456789012345679',
        name: '학습-심사-테스트',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('paginates a bounded thread history with bot authorization', async () => {
    const threadMessage = {
      id: '123456789012345679',
      type: 0,
      content: '학습 내용',
      timestamp: '2026-08-25T00:00:00.000000+00:00',
      author: { id: '123456789012345680', bot: false },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(Array.from({ length: 100 }, () => threadMessage)), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([threadMessage]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DiscordRestClient('bot-token');

    await expect(client.listThreadMessages('123456789012345679')).resolves.toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/123456789012345679/messages?limit=100',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ authorization: 'Bot bot-token' }),
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://discord.com/api/v10/channels/123456789012345679/messages?limit=100&before=123456789012345679',
      expect.objectContaining({ method: 'GET' }),
    );
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
