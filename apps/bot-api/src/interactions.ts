import {
  deferredChannelMessageResponse,
  ephemeralMessageResponse,
  parseInteraction,
  pongResponse,
  verifyDiscordRequest,
} from '@disciplinary-committee/discord';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

function json(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (publicKey === undefined) {
    return json(500, { error: 'Service unavailable' });
  }

  const body = event.body ?? '';
  const rawBody = event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  const signature = event.headers['x-signature-ed25519'];
  const timestamp = event.headers['x-signature-timestamp'];
  if (!verifyDiscordRequest({ publicKey, signature, timestamp, rawBody })) {
    return json(401, { error: 'Invalid request signature' });
  }

  try {
    const interaction = parseInteraction(rawBody);
    if (interaction.type === 1) {
      return json(200, pongResponse);
    }
    if (interaction.type === 2 || interaction.type === 3 || interaction.type === 5) {
      return json(200, deferredChannelMessageResponse);
    }
    return json(400, { error: 'Unsupported interaction' });
  } catch {
    return json(400, ephemeralMessageResponse('요청 형식을 처리할 수 없습니다.'));
  }
}
