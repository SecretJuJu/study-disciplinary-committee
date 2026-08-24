import nacl from 'tweetnacl';
import { z } from 'zod';

const maxClockSkewMilliseconds = 5 * 60 * 1_000;
const manageGuildPermission = 0x20n;

const interactionSchema = z.object({
  type: z.number().int(),
  id: z.string(),
  application_id: z.string(),
  token: z.string(),
  guild_id: z.string().optional(),
  member: z
    .object({
      user: z.object({ id: z.string() }),
      permissions: z.string().optional(),
    })
    .optional(),
  data: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      custom_id: z.string().max(100).optional(),
    })
    .passthrough()
    .optional(),
});

export type DiscordInteraction = z.infer<typeof interactionSchema>;

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
