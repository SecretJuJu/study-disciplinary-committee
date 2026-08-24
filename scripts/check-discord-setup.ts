import { z } from 'zod';

import {
  discordPermission,
  effectiveChannelPermissions,
  hasDiscordPermission,
} from './lib/discord-permissions.js';

const snowflakeSchema = z.string().regex(/^\d{17,20}$/);
const environmentSchema = z.object({
  DISCORD_APPLICATION_ID: snowflakeSchema,
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: snowflakeSchema,
  DISCORD_DEBUG_CHANNEL_ID: snowflakeSchema,
  DISCORD_SEND_TEST_MESSAGE: z.enum(['true', 'false']).default('true'),
});

const userSchema = z.object({ id: snowflakeSchema, username: z.string(), bot: z.boolean() });
const applicationSchema = z.object({
  id: snowflakeSchema,
  interactions_endpoint_url: z.string().url().nullable().optional(),
});
const guildSchema = z.object({ id: snowflakeSchema, name: z.string() });
const memberSchema = z.object({ roles: z.array(snowflakeSchema) });
const roleSchema = z.object({ id: snowflakeSchema, name: z.string(), permissions: z.string() });
const overwriteSchema = z.object({
  id: snowflakeSchema,
  type: z.union([z.literal(0), z.literal(1)]),
  allow: z.string(),
  deny: z.string(),
});
const channelSchema = z.object({
  id: snowflakeSchema,
  guild_id: snowflakeSchema,
  name: z.string(),
  permission_overwrites: z.array(overwriteSchema).default([]),
});
const commandSchema = z.object({ name: z.string() });
const messageSchema = z.object({ id: snowflakeSchema });

const environment = environmentSchema.parse(process.env);
const apiBaseUrl = 'https://discord.com/api/v10';

async function discordRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      'authorization': `Bot ${environment.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`Discord API ${path} failed with HTTP ${response.status}.`);
  }
  return schema.parse(body);
}

const bot = await discordRequest('/users/@me', userSchema);
if (!bot.bot || bot.id !== environment.DISCORD_APPLICATION_ID) {
  throw new Error('Bot identity does not match DISCORD_APPLICATION_ID.');
}

const [application, guild, member, roles, channel, commands] = await Promise.all([
  discordRequest('/applications/@me', applicationSchema),
  discordRequest(`/guilds/${environment.DISCORD_GUILD_ID}`, guildSchema),
  discordRequest(
    `/guilds/${environment.DISCORD_GUILD_ID}/members/${environment.DISCORD_APPLICATION_ID}`,
    memberSchema,
  ),
  discordRequest(`/guilds/${environment.DISCORD_GUILD_ID}/roles`, z.array(roleSchema)),
  discordRequest(`/channels/${environment.DISCORD_DEBUG_CHANNEL_ID}`, channelSchema),
  discordRequest(
    `/applications/${environment.DISCORD_APPLICATION_ID}/guilds/${environment.DISCORD_GUILD_ID}/commands`,
    z.array(commandSchema),
  ),
]);

if (application.id !== environment.DISCORD_APPLICATION_ID) {
  throw new Error('Discord application identity mismatch.');
}
if (guild.id !== environment.DISCORD_GUILD_ID) {
  throw new Error('Discord guild identity mismatch.');
}
if (channel.guild_id !== environment.DISCORD_GUILD_ID) {
  throw new Error('Debug channel does not belong to the configured guild.');
}

const effectivePermissions = effectiveChannelPermissions({
  guildId: guild.id,
  memberId: bot.id,
  memberRoleIds: member.roles,
  roles,
  overwrites: channel.permission_overwrites,
});
const permissionChecks = [
  ['View Channel', discordPermission.viewChannel],
  ['Send Messages', discordPermission.sendMessages],
  ['Embed Links', discordPermission.embedLinks],
] as const;
const missingPermissions = permissionChecks
  .filter(([, permission]) => !hasDiscordPermission(effectivePermissions, permission))
  .map(([name]) => name);

if (missingPermissions.length > 0) {
  throw new Error(`Debug channel is missing permissions: ${missingPermissions.join(', ')}.`);
}

let testMessageId: string | undefined;
if (environment.DISCORD_SEND_TEST_MESSAGE === 'true') {
  const message = await discordRequest(`/channels/${channel.id}/messages`, messageSchema, {
    method: 'POST',
    body: JSON.stringify({
      content: '✅ Discord 설정 자동 점검 통과',
      embeds: [
        {
          title: '스터디-징계위원회',
          description: 'Guild 설치와 debug 채널의 View/Send/Embed 권한이 정상입니다.',
          color: 0x57_f2_87,
        },
      ],
      allowed_mentions: { parse: [] },
    }),
  });
  testMessageId = message.id;
}

const statusLines = [
  `Bot: ${bot.username} (${bot.id})`,
  `Guild: ${guild.name} (${guild.id})`,
  `Debug channel: #${channel.name} (${channel.id})`,
  ...permissionChecks.map(
    ([name, permission]) =>
      `Permission ${name}: ${hasDiscordPermission(effectivePermissions, permission) ? 'OK' : 'MISSING'}`,
  ),
  `Permission Manage Roles: ${hasDiscordPermission(effectivePermissions, discordPermission.manageRoles) ? 'OK' : 'OPTIONAL/MISSING'}`,
  `Interaction endpoint: ${application.interactions_endpoint_url === null || application.interactions_endpoint_url === undefined ? 'NOT_CONFIGURED' : 'CONFIGURED'}`,
  `Guild commands: ${commands.length}`,
  `Test message: ${testMessageId === undefined ? 'SKIPPED' : `SENT (${testMessageId})`}`,
];
process.stdout.write(`${statusLines.join('\n')}\n`);
