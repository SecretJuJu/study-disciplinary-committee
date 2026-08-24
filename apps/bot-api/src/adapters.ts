import OpenAI from 'openai';
import type { ModelClient, DiscordFollowupClient } from './judge.js';
import type { DiscordChannelClient } from './outbox.js';

export class OpenAIResponsesClient implements ModelClient {
  private readonly client: OpenAI;
  public constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }
  public async create(
    request: Parameters<ModelClient['create']>[0],
  ): Promise<{ outputText: string }> {
    const response = await this.client.responses.create(request);
    return { outputText: response.output_text };
  }
}

export class DiscordRestClient implements DiscordFollowupClient, DiscordChannelClient {
  public constructor(private readonly botToken: string) {}
  public async editOriginal(input: {
    applicationId: string;
    interactionToken: string;
    content: string;
  }): Promise<void> {
    await this.request(
      `https://discord.com/api/v10/webhooks/${input.applicationId}/${input.interactionToken}/messages/@original`,
      'PATCH',
      { content: input.content },
    );
  }
  public async sendMessage(input: { channelId: string; content: string }): Promise<void> {
    await this.request(`https://discord.com/api/v10/channels/${input.channelId}/messages`, 'POST', {
      content: input.content,
      allowed_mentions: { parse: [] },
    });
  }
  private async request(url: string, method: string, body: object): Promise<void> {
    const response = await fetch(url, {
      method,
      headers: { 'authorization': `Bot ${this.botToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Discord API request failed: ${response.status}`);
    }
  }
}
