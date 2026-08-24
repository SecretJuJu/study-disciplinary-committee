import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscordRestClient } from '../src/adapters.js';

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
});
