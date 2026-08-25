import { z } from 'zod';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/);

export const prepareReviewJobSchema = z
  .object({
    kind: z.literal('prepare_review'),
    guildId: snowflakeSchema,
    sessionId: snowflakeSchema,
    userId: snowflakeSchema,
    channelId: snowflakeSchema,
    applicationId: snowflakeSchema,
    interactionToken: z.string().min(1).max(256),
  })
  .strict();

export const judgeThreadJobSchema = z
  .object({
    kind: z.literal('judge_thread'),
    guildId: snowflakeSchema,
    sessionId: snowflakeSchema,
    userId: snowflakeSchema,
  })
  .strict();

export const requestReviewJobSchema = z
  .object({
    kind: z.literal('request_review'),
    guildId: snowflakeSchema,
    sessionId: snowflakeSchema,
    userId: snowflakeSchema,
    channelId: snowflakeSchema,
    anchorMessageId: snowflakeSchema,
    requestedAt: z.string().datetime(),
  })
  .strict();

export const threadReviewJobSchema = z.discriminatedUnion('kind', [
  prepareReviewJobSchema,
  requestReviewJobSchema,
  judgeThreadJobSchema,
]);

export type PrepareReviewJob = z.infer<typeof prepareReviewJobSchema>;
export type JudgeThreadJob = z.infer<typeof judgeThreadJobSchema>;
export type RequestReviewJob = z.infer<typeof requestReviewJobSchema>;
export type ThreadReviewJob = z.infer<typeof threadReviewJobSchema>;
