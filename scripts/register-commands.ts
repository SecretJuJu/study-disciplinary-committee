import { commands } from '@disciplinary-committee/discord';

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const scope = process.env.DISCORD_COMMAND_SCOPE;
const guildId = process.env.DISCORD_COMMAND_GUILD_ID;
const interactionEndpoint = process.env.DISCORD_INTERACTION_ENDPOINT;
if (
  applicationId === undefined ||
  botToken === undefined ||
  (scope !== 'guild' && scope !== 'global')
) {
  throw new Error(
    'Set DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN, and DISCORD_COMMAND_SCOPE=guild|global.',
  );
}
if (scope === 'guild' && guildId === undefined) {
  throw new Error('DISCORD_COMMAND_GUILD_ID is required for guild commands.');
}
if (interactionEndpoint !== undefined) {
  const endpointUrl = new URL(interactionEndpoint);
  if (endpointUrl.protocol !== 'https:') {
    throw new Error('DISCORD_INTERACTION_ENDPOINT must use HTTPS.');
  }
  const applicationResponse = await fetch('https://discord.com/api/v10/applications/@me', {
    method: 'PATCH',
    headers: { 'authorization': `Bot ${botToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ interactions_endpoint_url: endpointUrl.toString() }),
  });
  if (!applicationResponse.ok) {
    throw new Error(`Discord interaction endpoint update failed: ${applicationResponse.status}`);
  }
}
const endpoint =
  scope === 'guild'
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`;
const response = await fetch(endpoint, {
  method: 'PUT',
  headers: { 'authorization': `Bot ${botToken}`, 'content-type': 'application/json' },
  body: JSON.stringify(commands),
});
if (!response.ok) {
  throw new Error(`Discord command registration failed: ${response.status}`);
}
process.stdout.write(`Registered ${commands.length} ${scope} commands.\n`);
