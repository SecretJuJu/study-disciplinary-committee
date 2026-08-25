import OpenAI from 'openai';
import { z } from 'zod';
import type { ModelClient, DiscordFollowupClient } from './judge.js';
import { NonRetryableModelError, RetryableModelError } from './model-errors.js';
import type { DiscordChannelClient } from './outbox.js';
import type { DiscordThreadClient, DiscordThreadMessage } from './thread-review.js';

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
      if (error instanceof RetryableModelError) {
        throw error;
      }
      if (errorCodeOf(error) === 'credit_balance_exhausted') {
        throw new NonRetryableModelError({ cause: error });
      }
      throw new RetryableModelError('ai_request_failed', { cause: error });
    }
  }
}

const snowflakeSchema = z.string().regex(/^\d{17,20}$/);
const messageSchema = z.object({ id: snowflakeSchema, channel_id: snowflakeSchema }).passthrough();
const channelSchema = z.object({ id: snowflakeSchema }).passthrough();
const threadMessageSchema = z
  .object({
    id: snowflakeSchema,
    type: z.number().int(),
    content: z.string(),
    timestamp: z.string().datetime({ offset: true }),
    author: z.object({ id: snowflakeSchema, bot: z.boolean().optional() }).passthrough(),
  })
  .passthrough();
const threadMessagePageSchema = z.array(threadMessageSchema).max(100);
const maximumThreadMessagePages = 5;

export class DiscordRestClient
  implements DiscordFollowupClient, DiscordChannelClient, DiscordThreadClient
{
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
  public async getOriginalMessage(input: {
    applicationId: string;
    interactionToken: string;
  }): Promise<{ id: string; channelId: string }> {
    const message = await this.requestJson(
      `https://discord.com/api/v10/webhooks/${input.applicationId}/${input.interactionToken}/messages/@original`,
      messageSchema,
      { method: 'GET', authorize: false },
    );
    return { id: message.id, channelId: message.channel_id };
  }
  public async ensurePublicThread(input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<{ id: string } | undefined> {
    try {
      const existing = await this.tryGetChannel(input.messageId);
      if (existing !== undefined) {
        return existing;
      }
      return await this.requestJson(
        `https://discord.com/api/v10/channels/${input.channelId}/messages/${input.messageId}/threads`,
        channelSchema,
        {
          method: 'POST',
          body: { name: input.name, auto_archive_duration: 1_440 },
          authorize: true,
        },
      );
    } catch (error) {
      if (error instanceof DiscordRequestError && error.status === 403) {
        return undefined;
      }
      const raced = await this.tryGetChannel(input.messageId);
      if (raced !== undefined) {
        return raced;
      }
      throw error;
    }
  }
  public async editChannelMessage(input: {
    channelId: string;
    messageId: string;
    content: string;
    components?: readonly unknown[];
  }): Promise<void> {
    await this.request(
      `https://discord.com/api/v10/channels/${input.channelId}/messages/${input.messageId}`,
      'PATCH',
      {
        content: input.content,
        components: input.components ?? [],
        allowed_mentions: { parse: [] },
      },
    );
  }
  public async listThreadMessages(threadId: string): Promise<readonly DiscordThreadMessage[]> {
    const messages: DiscordThreadMessage[] = [];
    let before: string | undefined;
    for (let pageNumber = 0; pageNumber < maximumThreadMessagePages; pageNumber += 1) {
      const page = await this.requestJson(
        `https://discord.com/api/v10/channels/${threadId}/messages?limit=100${before === undefined ? '' : `&before=${before}`}`,
        threadMessagePageSchema,
        { method: 'GET', authorize: true },
      );
      messages.push(...page);
      const oldest = page.at(-1);
      if (page.length < 100 || oldest === undefined) {
        break;
      }
      before = oldest.id;
    }
    return messages;
  }
  private async tryGetChannel(channelId: string): Promise<{ id: string } | undefined> {
    try {
      return await this.requestJson(
        `https://discord.com/api/v10/channels/${channelId}`,
        channelSchema,
        { method: 'GET', authorize: true },
      );
    } catch (error) {
      if (error instanceof DiscordRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
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
  private async requestJson<T>(
    url: string,
    schema: z.ZodType<T>,
    input: { method: string; authorize: boolean; body?: object },
  ): Promise<T> {
    const response = await fetch(url, {
      method: input.method,
      headers: {
        ...(input.authorize ? { authorization: `Bot ${this.botToken}` } : {}),
        'content-type': 'application/json',
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    if (!response.ok) {
      throw new DiscordRequestError(response.status);
    }
    return schema.parse((await response.json()) as unknown);
  }
}
