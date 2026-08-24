import nacl from 'tweetnacl';
import { z } from 'zod';

const maxClockSkewMilliseconds = 5 * 60 * 1_000;
const manageGuildPermission = 0x20n;
const snowflakeSchema = z.string().regex(/^\d{17,20}$/);

const interactionSchema = z.object({
  type: z.number().int(),
  id: snowflakeSchema,
  application_id: snowflakeSchema,
  token: z.string().min(1).max(256),
  guild_id: snowflakeSchema.optional(),
  member: z
    .object({
      user: z.object({ id: snowflakeSchema }).passthrough(),
      permissions: z.string().regex(/^\d+$/).optional(),
    })
    .passthrough()
    .optional(),
  data: z
    .object({
      id: snowflakeSchema.optional(),
      type: z.number().int().optional(),
      name: z.string().min(1).max(32).optional(),
      custom_id: z.string().max(100).optional(),
      options: z.array(z.unknown()).max(25).optional(),
    })
    .passthrough()
    .optional(),
});

export type DiscordInteraction = z.infer<typeof interactionSchema>;

const commandDataSchema = z.object({
  id: snowflakeSchema,
  type: z.literal(1),
  name: z.string().min(1).max(32),
  options: z.array(z.unknown()).max(25).optional(),
});

const emptyOptionsSchema = z.tuple([]).optional();

const settingsViewOptionSchema = z
  .object({
    type: z.literal(1),
    name: z.literal('보기'),
    options: emptyOptionsSchema,
  })
  .strict();

const settingsSaveValueOptionSchema = z.discriminatedUnion('name', [
  z
    .object({
      type: z.literal(7),
      name: z.literal('제출채널'),
      value: snowflakeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal(7),
      name: z.literal('판결채널'),
      value: snowflakeSchema,
    })
    .strict(),
]);

const settingsSaveOptionSchema = z
  .object({
    type: z.literal(1),
    name: z.literal('저장'),
    options: z.array(settingsSaveValueOptionSchema).length(2),
  })
  .strict();

const studyValueOptionSchema = z.discriminatedUnion('name', [
  z
    .object({
      type: z.literal(3),
      name: z.literal('학습내용'),
      value: z.string().trim().min(1).max(1_500),
    })
    .strict(),
  z
    .object({
      type: z.literal(4),
      name: z.literal('학습시간'),
      value: z.number().int().min(1).max(1_440),
    })
    .strict(),
  z
    .object({
      type: z.literal(3),
      name: z.literal('배운점'),
      value: z.string().trim().min(1).max(1_000),
    })
    .strict(),
]);

export type ParsedApplicationCommand =
  | { name: 'help' }
  | { name: '설정'; action: '보기' }
  | {
      name: '설정';
      action: '저장';
      submissionChannelId: string;
      verdictChannelId: string;
    }
  | {
      name: '심사';
      studyContent: string;
      durationMinutes?: number;
      learnedText?: string;
    }
  | { name: '내기록' };

function assertUniqueOptionNames(options: readonly { name: string }[]): void {
  const names = options.map((option) => option.name);
  if (new Set(names).size !== names.length) {
    throw new Error('Discord command options must have unique names.');
  }
}

function parseSettingsCommand(options: readonly unknown[]): ParsedApplicationCommand {
  const [subcommand] = z
    .tuple([z.union([settingsViewOptionSchema, settingsSaveOptionSchema])])
    .parse(options);

  if (subcommand.name === '보기') {
    return { name: '설정', action: '보기' };
  }

  assertUniqueOptionNames(subcommand.options);
  let submissionChannelId: string | undefined;
  let verdictChannelId: string | undefined;
  for (const option of subcommand.options) {
    if (option.name === '제출채널') {
      submissionChannelId = option.value;
    } else {
      verdictChannelId = option.value;
    }
  }

  return {
    name: '설정',
    action: '저장',
    submissionChannelId: snowflakeSchema.parse(submissionChannelId),
    verdictChannelId: snowflakeSchema.parse(verdictChannelId),
  };
}

function parseStudyCommand(options: readonly unknown[]): ParsedApplicationCommand {
  const parsedOptions = z.array(studyValueOptionSchema).min(1).max(3).parse(options);
  assertUniqueOptionNames(parsedOptions);

  let studyContent: string | undefined;
  let durationMinutes: number | undefined;
  let learnedText: string | undefined;
  for (const option of parsedOptions) {
    if (option.name === '학습내용') {
      studyContent = option.value;
    } else if (option.name === '학습시간') {
      durationMinutes = option.value;
    } else {
      learnedText = option.value;
    }
  }

  return {
    name: '심사',
    studyContent: z.string().min(1).max(1_500).parse(studyContent),
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(learnedText === undefined ? {} : { learnedText }),
  };
}

export function parseApplicationCommand(interaction: DiscordInteraction): ParsedApplicationCommand {
  if (interaction.type !== 2) {
    throw new Error('Interaction is not an application command.');
  }

  const data = commandDataSchema.parse(interaction.data);
  const options = data.options ?? [];

  if (data.name === 'help') {
    emptyOptionsSchema.parse(options);
    return { name: 'help' };
  }
  if (data.name === '설정') {
    return parseSettingsCommand(options);
  }
  if (data.name === '심사') {
    return parseStudyCommand(options);
  }
  if (data.name === '내기록') {
    emptyOptionsSchema.parse(options);
    return { name: '내기록' };
  }

  throw new Error('Unsupported application command.');
}

export function verifyDiscordRequest(input: {
  publicKey: string;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  now?: Date;
}): boolean {
  if (input.signature === undefined || input.timestamp === undefined) {
    return false;
  }

  const timestampMilliseconds = Number(input.timestamp) * 1_000;
  const now = input.now?.getTime() ?? Date.now();
  if (
    !Number.isFinite(timestampMilliseconds) ||
    Math.abs(now - timestampMilliseconds) > maxClockSkewMilliseconds
  ) {
    return false;
  }

  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(`${input.timestamp}${input.rawBody}`),
      Buffer.from(input.signature, 'hex'),
      Buffer.from(input.publicKey, 'hex'),
    );
  } catch {
    return false;
  }
}

export function parseInteraction(rawBody: string): DiscordInteraction {
  return interactionSchema.parse(JSON.parse(rawBody));
}

export function hasManageGuildPermission(interaction: DiscordInteraction): boolean {
  const permissions = interaction.member?.permissions;
  if (permissions === undefined) {
    return false;
  }

  try {
    return (BigInt(permissions) & manageGuildPermission) === manageGuildPermission;
  } catch {
    return false;
  }
}

export const pongResponse = { type: 1 } as const;
export const deferredChannelMessageResponse = { type: 5 } as const;
export const ephemeralMessageResponse = (content: string) => ({
  type: 4,
  data: { content, flags: 1 << 6 },
});
