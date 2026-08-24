export const discordPermission = {
  administrator: 1n << 3n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  embedLinks: 1n << 14n,
  manageRoles: 1n << 28n,
} as const;

export type DiscordRolePermission = {
  id: string;
  permissions: string;
};

export type DiscordPermissionOverwrite = {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
};

function applyOverwrite(permissions: bigint, overwrite: DiscordPermissionOverwrite): bigint {
  return (permissions & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
}

export function effectiveChannelPermissions(input: {
  guildId: string;
  memberId: string;
  memberRoleIds: readonly string[];
  roles: readonly DiscordRolePermission[];
  overwrites: readonly DiscordPermissionOverwrite[];
}): bigint {
  const everyoneRole = input.roles.find((role) => role.id === input.guildId);
  if (everyoneRole === undefined) {
    throw new Error('Discord @everyone role is missing.');
  }

  const memberRoleIds = new Set(input.memberRoleIds);
  let permissions = BigInt(everyoneRole.permissions);
  for (const role of input.roles) {
    if (memberRoleIds.has(role.id)) {
      permissions |= BigInt(role.permissions);
    }
  }
  if ((permissions & discordPermission.administrator) !== 0n) {
    return (1n << 63n) - 1n;
  }

  const everyoneOverwrite = input.overwrites.find(
    (overwrite) => overwrite.type === 0 && overwrite.id === input.guildId,
  );
  if (everyoneOverwrite !== undefined) {
    permissions = applyOverwrite(permissions, everyoneOverwrite);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of input.overwrites) {
    if (overwrite.type === 0 && memberRoleIds.has(overwrite.id)) {
      roleAllow |= BigInt(overwrite.allow);
      roleDeny |= BigInt(overwrite.deny);
    }
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const memberOverwrite = input.overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === input.memberId,
  );
  return memberOverwrite === undefined ? permissions : applyOverwrite(permissions, memberOverwrite);
}

export function hasDiscordPermission(permissions: bigint, permission: bigint): boolean {
  return (permissions & permission) === permission;
}
