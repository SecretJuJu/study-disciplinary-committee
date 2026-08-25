import { describe, expect, it } from 'vitest';

import {
  discordPermission,
  effectiveChannelPermissions,
  hasDiscordPermission,
} from './discord-permissions.js';

describe('effectiveChannelPermissions', () => {
  it('combines roles and applies channel role and member overwrites in Discord order', () => {
    const permissions = effectiveChannelPermissions({
      guildId: 'guild',
      memberId: 'bot',
      memberRoleIds: ['bot-role'],
      roles: [
        { id: 'guild', permissions: String(discordPermission.viewChannel) },
        {
          id: 'bot-role',
          permissions: String(
            discordPermission.sendMessages |
              discordPermission.embedLinks |
              discordPermission.readMessageHistory |
              discordPermission.createPublicThreads |
              discordPermission.sendMessagesInThreads,
          ),
        },
      ],
      overwrites: [
        { id: 'guild', type: 0, allow: '0', deny: String(discordPermission.sendMessages) },
        {
          id: 'bot-role',
          type: 0,
          allow: String(discordPermission.sendMessages),
          deny: String(discordPermission.embedLinks),
        },
        {
          id: 'bot',
          type: 1,
          allow: String(discordPermission.embedLinks),
          deny: '0',
        },
      ],
    });

    expect(hasDiscordPermission(permissions, discordPermission.viewChannel)).toBe(true);
    expect(hasDiscordPermission(permissions, discordPermission.sendMessages)).toBe(true);
    expect(hasDiscordPermission(permissions, discordPermission.embedLinks)).toBe(true);
    expect(hasDiscordPermission(permissions, discordPermission.readMessageHistory)).toBe(true);
    expect(hasDiscordPermission(permissions, discordPermission.createPublicThreads)).toBe(true);
    expect(hasDiscordPermission(permissions, discordPermission.sendMessagesInThreads)).toBe(true);
  });

  it('treats administrator as having every checked permission', () => {
    const permissions = effectiveChannelPermissions({
      guildId: 'guild',
      memberId: 'bot',
      memberRoleIds: ['admin'],
      roles: [
        { id: 'guild', permissions: '0' },
        { id: 'admin', permissions: String(discordPermission.administrator) },
      ],
      overwrites: [{ id: 'bot', type: 1, allow: '0', deny: String(discordPermission.viewChannel) }],
    });

    expect(hasDiscordPermission(permissions, discordPermission.viewChannel)).toBe(true);
  });
});
