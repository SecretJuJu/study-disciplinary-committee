import { z } from 'zod';

const outboxJobSchema = z
  .object({
    channelId: z.string().regex(/^\d{17,20}$/),
    content: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type OutboxJob = z.infer<typeof outboxJobSchema>;
export type DiscordChannelClient = { sendMessage(input: OutboxJob): Promise<void> };
export class OutboxWorker {
  public constructor(private readonly discord: DiscordChannelClient) {}
  public async process(rawJob: unknown): Promise<void> {
    await this.discord.sendMessage(outboxJobSchema.parse(rawJob));
  }
}
