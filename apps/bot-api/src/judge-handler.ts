import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { judgmentSchema, type Judgment } from '@disciplinary-committee/domain';
import { DynamoReviewRepository, sessionPk, verdictSk } from '@disciplinary-committee/persistence';
import type { SQSBatchResponse } from 'aws-lambda';
import { z } from 'zod';

import { OpenAIResponsesClient, DiscordRestClient } from './adapters.js';
import { DiscordDiagnosticReporter } from './diagnostics.js';
import { JudgeWorker, type JudgeRepository } from './judge.js';

const runtimeEnvironmentSchema = z
  .object({
    TABLE_NAME: z.string().trim().min(1),
    APP_SECRET_ARN: z.string().trim().min(1),
    DISCORD_DEBUG_CHANNEL_ID: z.string().regex(/^\d{17,20}$/),
  })
  .strict();

const appSecretsSchema = z
  .object({
    OPENAI_API_KEY: z.string().trim().min(20),
    DISCORD_BOT_TOKEN: z.string().trim().min(20),
  })
  .strict();
export type AppSecrets = z.infer<typeof appSecretsSchema>;

const sqsEventSchema = z
  .object({
    Records: z
      .array(
        z
          .object({
            messageId: z.string().trim().min(1).max(256),
            body: z.string(),
          })
          .passthrough(),
      )
      .min(1)
      .max(10),
  })
  .strict();

const verdictRecordSchema = z
  .object({
    PK: z.string(),
    SK: z.string(),
    entityType: z.literal('Verdict'),
    sessionId: z.string().min(1).max(128),
    userId: z.string().regex(/^\d{17,20}$/),
    judgment: judgmentSchema,
    pointsDelta: z.number().int().nonnegative(),
    finalizedAt: z.string().datetime(),
    reason: z.literal('judgment'),
  })
  .strict();

export type SecretValueClient = {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined }>;
};

export function createCachedAppSecretsLoader(
  client: SecretValueClient,
  secretArn: string,
): () => Promise<AppSecrets> {
  let cached: Promise<AppSecrets> | undefined;

  return async () => {
    if (cached === undefined) {
      cached = client
        .send(new GetSecretValueCommand({ SecretId: secretArn }))
        .then((result) => {
          if (result.SecretString === undefined) {
            throw new TypeError('Application secret must be a JSON string');
          }
          return appSecretsSchema.parse(JSON.parse(result.SecretString) as unknown);
        })
        .catch((error: unknown) => {
          cached = undefined;
          throw error;
        });
    }
    return cached;
  };
}

class DynamoJudgeRepository implements JudgeRepository {
  private readonly repository: DynamoReviewRepository;

  public constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    this.repository = new DynamoReviewRepository(client, tableName);
  }

  public getUserStats(
    guildId: string,
    userId: string,
  ): ReturnType<JudgeRepository['getUserStats']> {
    return this.repository.getUserStats(guildId, userId);
  }

  public finalizeJudgment(
    input: Parameters<JudgeRepository['finalizeJudgment']>[0],
  ): Promise<void> {
    return this.repository.finalizeJudgment(input);
  }

  public async getFinalizedJudgment(
    sessionId: string,
    userId: string,
  ): Promise<Judgment | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: sessionPk(sessionId), SK: verdictSk(userId) },
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) {
      return undefined;
    }

    const record = verdictRecordSchema.parse(result.Item);
    if (record.PK !== sessionPk(sessionId) || record.SK !== verdictSk(userId)) {
      throw new TypeError('Stored verdict envelope is invalid');
    }
    return record.judgment;
  }
}

export type JudgeProcessor = Pick<JudgeWorker, 'process'>;
export type JudgeProcessorLoader = () => Promise<JudgeProcessor>;

function parseMessageBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

async function createRuntimeWorker(): Promise<JudgeWorker> {
  const environment = runtimeEnvironmentSchema.parse({
    TABLE_NAME: process.env.TABLE_NAME,
    APP_SECRET_ARN: process.env.APP_SECRET_ARN,
    DISCORD_DEBUG_CHANNEL_ID: process.env.DISCORD_DEBUG_CHANNEL_ID,
  });
  const secretsClient = new SecretsManagerClient({});
  const loadSecrets = createCachedAppSecretsLoader(
    { send: (command) => secretsClient.send(command) },
    environment.APP_SECRET_ARN,
  );
  const secrets = await loadSecrets();
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const repository = new DynamoJudgeRepository(documentClient, environment.TABLE_NAME);
  const discord = new DiscordRestClient(secrets.DISCORD_BOT_TOKEN);
  return new JudgeWorker(
    new OpenAIResponsesClient(secrets.OPENAI_API_KEY),
    repository,
    discord,
    new DiscordDiagnosticReporter(discord, environment.DISCORD_DEBUG_CHANNEL_ID),
  );
}

let runtimeWorker: Promise<JudgeWorker> | undefined;
function loadRuntimeWorker(): Promise<JudgeWorker> {
  if (runtimeWorker === undefined) {
    runtimeWorker = createRuntimeWorker().catch((error: unknown) => {
      runtimeWorker = undefined;
      throw error;
    });
  }
  return runtimeWorker;
}

export function createJudgeHandler(
  loadProcessor: JudgeProcessorLoader = loadRuntimeWorker,
): (event: unknown) => Promise<SQSBatchResponse> {
  return async (rawEvent) => {
    const parsedEvent = sqsEventSchema.safeParse(rawEvent);
    if (!parsedEvent.success) {
      throw new TypeError('Invalid SQS event');
    }
    const event = parsedEvent.data;
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

    for (const record of event.Records) {
      try {
        const processor = await loadProcessor();
        await processor.process(parseMessageBody(record.body));
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}

export const handler = createJudgeHandler();
