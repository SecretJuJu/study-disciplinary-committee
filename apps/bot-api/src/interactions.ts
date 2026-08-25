import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  ephemeralMessageResponse,
  parseInteraction,
  pongResponse,
  verifyDiscordRequest,
} from '@disciplinary-committee/discord';
import { DynamoReviewRepository } from '@disciplinary-committee/persistence';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';

import { SqsJudgeQueue } from './interaction-adapters.js';
import {
  routeApplicationCommand,
  routeComponentInteraction,
  type InteractionDependencies,
} from './interaction-service.js';

const runtimeEnvironmentSchema = z
  .object({
    TABLE_NAME: z.string().trim().min(1),
    JUDGE_QUEUE_URL: z.string().url(),
  })
  .strict();

function json(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function createRuntimeDependencies(): InteractionDependencies {
  const environment = runtimeEnvironmentSchema.parse({
    TABLE_NAME: process.env.TABLE_NAME,
    JUDGE_QUEUE_URL: process.env.JUDGE_QUEUE_URL,
  });
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    repository: new DynamoReviewRepository(documentClient, environment.TABLE_NAME),
    judgeQueue: new SqsJudgeQueue(new SQSClient({}), environment.JUDGE_QUEUE_URL),
    now: () => new Date(),
  };
}

export function createInteractionHandler(
  injectedDependencies?: InteractionDependencies,
): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2> {
  return async (event) => {
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
      if (interaction.type !== 2 && interaction.type !== 3) {
        return json(400, ephemeralMessageResponse('지원하지 않는 요청입니다.'));
      }

      try {
        const dependencies = injectedDependencies ?? createRuntimeDependencies();
        return json(
          200,
          interaction.type === 2
            ? await routeApplicationCommand(interaction, dependencies)
            : await routeComponentInteraction(interaction, dependencies),
        );
      } catch {
        return json(
          200,
          ephemeralMessageResponse(
            '요청을 처리하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의해주세요.',
          ),
        );
      }
    } catch {
      return json(400, ephemeralMessageResponse('요청 형식을 처리할 수 없습니다.'));
    }
  };
}

export const handler = createInteractionHandler();
