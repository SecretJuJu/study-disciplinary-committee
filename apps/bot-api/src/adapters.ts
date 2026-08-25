import OpenAI from 'openai';
import type { ModelClient, DiscordFollowupClient } from './judge.js';
import { NonRetryableModelError, RetryableModelError } from './model-errors.js';
import type { DiscordChannelClient } from './outbox.js';

export type OpenAIResponseSender = {
  create(
    request: Parameters<ModelClient['create']>[0],
  ): Promise<{ output_text: string; status?: string }>;
};

class DiscordRequestError extends Error {
  public readonly diagnosticCode: 'discord_request_rejected' | 'discord_service_unavailable';

  public constructor(public readonly status: number) {
    super(`Discord API request failed: ${status}`);
    this.name = 'DiscordRequestError';
    this.diagnosticCode =
      status === 429 || status >= 500 ? 'discord_service_unavailable' : 'discord_request_rejected';
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

export class OpenAIResponsesClient implements ModelClient {
  private readonly sender: OpenAIResponseSender;
  public constructor(apiKey: string, sender?: OpenAIResponseSender) {
    if (sender !== undefined) {
      this.sender = sender;
      return;
    }
    const client = new OpenAI({ apiKey });
    this.sender = {
      create: (request) => client.responses.create(request),
    };
  }
  public async create(
    request: Parameters<ModelClient['create']>[0],
  ): Promise<{ outputText: string }> {
    try {
      const response = await this.sender.create(request);
      if (response.status !== 'completed' || response.output_text.length === 0) {
        throw new RetryableModelError('ai_output_incomplete');
      }
      return { outputText: response.output_text };
    } catch (error) {
      if (errorCodeOf(error) === 'credit_balance_exhausted') {
        throw new NonRetryableModelError({ cause: error });
      }
      throw error;
    }
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
      throw new DiscordRequestError(response.status);
    }
  }
}
