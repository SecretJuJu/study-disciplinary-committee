import { commandHelp } from '@disciplinary-committee/discord';
import {
  defaultDisciplinaryThresholds,
  defaultScorePolicy,
  type GuildSettings,
  type UserStats,
} from '@disciplinary-committee/domain';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ThreadReviewSession } from '@disciplinary-committee/persistence';

import type {
  InteractionDependencies,
  InteractionRepository,
  JudgeQueue,
} from '../src/interaction-service.js';
import { createInteractionHandler } from '../src/interactions.js';

const interactionId = '1541459000000000001';
const applicationId = '1541457217830522940';
const commandId = '1541459000000000002';
const guildId = '1541458098101952522';
const userId = '1541459000000000003';
const submissionChannelId = '1541458116195917935';
const verdictChannelId = '1541459000000000004';
const updatedSubmissionChannelId = '1541459000000000005';
const updatedVerdictChannelId = '1541459000000000006';
const fixedNow = new Date('2026-08-25T00:00:00.000Z');
const savedPublicKey = process.env.DISCORD_PUBLIC_KEY;
const keyPair = nacl.sign.keyPair();
const messageResponseSchema = z.object({
  type: z.literal(4),
  data: z.object({ content: z.string(), flags: z.literal(64) }),
});

const settings: GuildSettings = {
  guildId,
  enabled: true,
  timezone: 'Asia/Seoul',
  cadenceMinutes: 720,
  submissionWindowMinutes: 30,
  submissionChannelId,
  verdictChannelId,
  targetRoleId: '1541459000000000007',
  roleChangesEnabled: true,
  scorePolicy: { insufficient: 1, meaningless: 4, absent: 5 },
  thresholds: { observationAt: 2, disciplinaryAt: 4, severeAt: 6 },
  configVersion: 4,
};

const stats: UserStats = {
  userId,
  totalReviews: 3,
  meaningfulReviews: 2,
  insufficientReviews: 1,
  meaninglessReviews: 0,
  absentReviews: 0,
  disciplinaryPoints: 1,
  currentSurvivalStreak: 1,
  bestSurvivalStreak: 2,
};

const threadSession: ThreadReviewSession = {
  sessionId: interactionId,
  guildId,
  ownerId: userId,
  channelId: submissionChannelId,
  state: 'draft',
  createdAt: fixedNow.toISOString(),
  deadlineAt: '2026-08-25T00:30:00.000Z',
  expiresAt: 1_795_392_000,
  configVersion: 4,
  anchorMessageId: interactionId,
  threadId: interactionId,
};

function createDependencies(input?: {
  settings?: GuildSettings;
  stats?: UserStats;
  saveError?: Error;
  queueError?: Error;
  session?: ThreadReviewSession;
  claimed?: boolean;
}): {
  dependencies: InteractionDependencies;
  repository: InteractionRepository;
  judgeQueue: JudgeQueue;
} {
  const repository: InteractionRepository = {
    getGuildSettings: vi.fn(async () => input?.settings),
    saveGuildSettings: vi.fn(async () => {
      if (input?.saveError !== undefined) {
        throw input.saveError;
      }
    }),
    getUserStats: vi.fn(async () => input?.stats),
    createThreadReview: vi.fn(async () => 'created' as const),
    getThreadReview: vi.fn(async () => input?.session),
    claimThreadReview: vi.fn(async () => input?.claimed ?? true),
    reopenThreadReview: vi.fn(async () => undefined),
  };
  const judgeQueue: JudgeQueue = {
    enqueue: vi.fn(async () => {
      if (input?.queueError !== undefined) {
        throw input.queueError;
      }
    }),
  };
  return {
    dependencies: { repository, judgeQueue, now: () => fixedNow },
    repository,
    judgeQueue,
  };
}

function commandInteraction(input: {
  name: string;
  options?: readonly unknown[];
  permissions?: string;
  channelId?: string;
}): object {
  return {
    type: 2,
    id: interactionId,
    application_id: applicationId,
    token: 'interaction-token-for-test',
    guild_id: guildId,
    channel_id: input.channelId ?? submissionChannelId,
    member: {
      user: { id: userId },
      ...(input.permissions === undefined ? {} : { permissions: input.permissions }),
    },
    data: {
      id: commandId,
      type: 1,
      name: input.name,
      ...(input.options === undefined ? {} : { options: input.options }),
    },
  };
}

function componentInteraction(input?: {
  actorId?: string;
  messageId?: string;
  channelId?: string;
}): object {
  return {
    type: 3,
    id: '1541459000000000010',
    application_id: applicationId,
    token: 'component-token-for-test',
    guild_id: guildId,
    channel_id: input?.channelId ?? submissionChannelId,
    member: { user: { id: input?.actorId ?? userId } },
    message: { id: input?.messageId ?? interactionId },
    data: { component_type: 2, custom_id: `review_submit:${interactionId}` },
  };
}

function signedEvent(payload: object): APIGatewayProxyEventV2 {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(`${timestamp}${rawBody}`), keyPair.secretKey),
  ).toString('hex');
  return {
    version: '2.0',
    routeKey: 'POST /interactions',
    rawPath: '/interactions',
    rawQueryString: '',
    body: rawBody,
    isBase64Encoded: false,
    headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
    requestContext: {
      accountId: 'test-account',
      apiId: 'test-api',
      domainName: 'test.execute-api.ap-northeast-2.amazonaws.com',
      domainPrefix: 'test',
      http: {
        method: 'POST',
        path: '/interactions',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'test-request',
      routeKey: 'POST /interactions',
      stage: '$default',
      time: '25/Aug/2026:00:00:00 +0000',
      timeEpoch: fixedNow.getTime(),
    },
  };
}

function structuredResponse(response: APIGatewayProxyResultV2): {
  statusCode?: number | undefined;
  body?: string | undefined;
} {
  if (response === undefined || typeof response === 'string') {
    throw new Error('Expected an API Gateway response object.');
  }
  return response;
}

async function invoke(
  dependencies: InteractionDependencies,
  payload: object,
): Promise<{ statusCode?: number | undefined; body?: string | undefined }> {
  return structuredResponse(await createInteractionHandler(dependencies)(signedEvent(payload)));
}

beforeEach(() => {
  process.env.DISCORD_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('hex');
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedPublicKey === undefined) {
    delete process.env.DISCORD_PUBLIC_KEY;
  } else {
    process.env.DISCORD_PUBLIC_KEY = savedPublicKey;
  }
});

describe('interaction Lambda', () => {
  it('returns PONG only after signature verification with production-format snowflakes', async () => {
    const { dependencies } = createDependencies();
    const response = await invoke(dependencies, {
      type: 1,
      id: interactionId,
      application_id: applicationId,
      token: 'ping-token',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"type":1}');
  });

  it('rejects an unsigned request before invoking dependencies', async () => {
    const { dependencies, repository } = createDependencies();
    const response = structuredResponse(
      await createInteractionHandler(dependencies)({
        ...signedEvent(commandInteraction({ name: 'help' })),
        headers: {},
      }),
    );

    expect(response.statusCode).toBe(401);
    expect(repository.getGuildSettings).not.toHaveBeenCalled();
  });

  it('renders manifest-based help immediately without storage or AI queue access', async () => {
    const { dependencies, repository, judgeQueue } = createDependencies();
    const response = await invoke(dependencies, commandInteraction({ name: 'help' }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? '')).toEqual({
      type: 4,
      data: { content: commandHelp, flags: 64 },
    });
    expect(repository.getGuildSettings).not.toHaveBeenCalled();
    expect(judgeQueue.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when settings are requested without Manage Guild permission', async () => {
    const { dependencies, repository } = createDependencies({ settings });
    const response = await invoke(
      dependencies,
      commandInteraction({
        name: '설정',
        permissions: '0',
        options: [{ type: 1, name: '보기' }],
      }),
    );

    expect(JSON.parse(response.body ?? '')).toEqual({
      type: 4,
      data: { content: '서버 관리 권한이 필요합니다.', flags: 64 },
    });
    expect(repository.getGuildSettings).not.toHaveBeenCalled();
  });

  it('shows saved guild settings immediately to an authorized administrator', async () => {
    const { dependencies } = createDependencies({ settings });
    const response = await invoke(
      dependencies,
      commandInteraction({
        name: '설정',
        permissions: '32',
        options: [{ type: 1, name: '보기' }],
      }),
    );
    const body = messageResponseSchema.parse(JSON.parse(response.body ?? ''));

    expect(body.type).toBe(4);
    expect(body.data.content).toContain(`<#${submissionChannelId}>`);
    expect(body.data.content).toContain('설정 버전: 4');
  });

  it('preserves existing policy while changing channels and incrementing configVersion', async () => {
    const { dependencies, repository } = createDependencies({ settings });
    const response = await invoke(
      dependencies,
      commandInteraction({
        name: '설정',
        permissions: '32',
        options: [
          {
            type: 1,
            name: '저장',
            options: [
              { type: 7, name: '제출채널', value: updatedSubmissionChannelId },
              { type: 7, name: '판결채널', value: updatedVerdictChannelId },
            ],
          },
        ],
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(repository.saveGuildSettings).toHaveBeenCalledWith({
      settings: {
        ...settings,
        submissionChannelId: updatedSubmissionChannelId,
        verdictChannelId: updatedVerdictChannelId,
        configVersion: 5,
      },
      expectedConfigVersion: 4,
    });
    expect(JSON.parse(response.body ?? '')).toMatchObject({ type: 4, data: { flags: 64 } });
  });

  it('creates safe defaults when guild settings are saved for the first time', async () => {
    const { dependencies, repository } = createDependencies();
    await invoke(
      dependencies,
      commandInteraction({
        name: '설정',
        permissions: '32',
        options: [
          {
            type: 1,
            name: '저장',
            options: [
              { type: 7, name: '제출채널', value: submissionChannelId },
              { type: 7, name: '판결채널', value: verdictChannelId },
            ],
          },
        ],
      }),
    );

    expect(repository.saveGuildSettings).toHaveBeenCalledWith({
      settings: {
        guildId,
        enabled: true,
        timezone: 'Asia/Seoul',
        cadenceMinutes: 1_440,
        submissionWindowMinutes: 60,
        submissionChannelId,
        verdictChannelId,
        roleChangesEnabled: false,
        scorePolicy: defaultScorePolicy,
        thresholds: defaultDisciplinaryThresholds,
        configVersion: 1,
      },
    });
  });

  it('does not expose storage errors when saving settings fails', async () => {
    const saveError = new Error('sensitive conditional write detail');
    const { dependencies } = createDependencies({ saveError });
    const response = await invoke(
      dependencies,
      commandInteraction({
        name: '설정',
        permissions: '32',
        options: [
          {
            type: 1,
            name: '저장',
            options: [
              { type: 7, name: '제출채널', value: submissionChannelId },
              { type: 7, name: '판결채널', value: verdictChannelId },
            ],
          },
        ],
      }),
    );
    const body = messageResponseSchema.parse(JSON.parse(response.body ?? ''));

    expect(body.data.content).toContain('요청을 처리하지 못했습니다.');
    expect(body.data.content).not.toContain(saveError.message);
  });

  it('returns zeroed stats immediately for a user without prior reviews', async () => {
    const { dependencies, repository } = createDependencies();
    const response = await invoke(dependencies, commandInteraction({ name: '내기록' }));
    const body = messageResponseSchema.parse(JSON.parse(response.body ?? ''));

    expect(repository.getUserStats).toHaveBeenCalledWith(guildId, userId);
    expect(body.type).toBe(4);
    expect(body.data.content).toContain('전체 심사: 0회');
    expect(body.data.content).toContain('누적 징계 점수: 0점');
  });

  it('creates a draft and prepare job before returning an immediate public response', async () => {
    const { dependencies, repository, judgeQueue } = createDependencies({ settings, stats });
    const response = await invoke(dependencies, commandInteraction({ name: '심사' }));

    expect(repository.createThreadReview).toHaveBeenCalledWith({
      guildId,
      sessionId: interactionId,
      ownerId: userId,
      channelId: submissionChannelId,
      createdAt: '2026-08-25T00:00:00.000Z',
      deadlineAt: '2026-08-25T00:30:00.000Z',
      expiresAt: 1_795_392_000,
      configVersion: 4,
    });
    expect(judgeQueue.enqueue).toHaveBeenCalledWith({
      kind: 'prepare_review',
      guildId,
      sessionId: interactionId,
      userId,
      channelId: submissionChannelId,
      interactionToken: 'interaction-token-for-test',
      applicationId,
    });
    expect(JSON.parse(response.body ?? '')).toMatchObject({
      type: 4,
      data: { content: expect.any(String) },
    });
    expect(JSON.parse(response.body ?? '').data.flags).toBeUndefined();
    expect(vi.mocked(repository.createThreadReview).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(judgeQueue.enqueue).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('rejects review creation outside the configured submission channel', async () => {
    const { dependencies, repository, judgeQueue } = createDependencies({ settings });
    const response = await invoke(
      dependencies,
      commandInteraction({ name: '심사', channelId: verdictChannelId }),
    );

    expect(JSON.parse(response.body ?? '')).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(repository.createThreadReview).not.toHaveBeenCalled();
    expect(judgeQueue.enqueue).not.toHaveBeenCalled();
  });

  it('returns an immediate safe error instead of deferring when queue enqueue fails', async () => {
    const queueError = new Error('sensitive upstream queue detail');
    const { dependencies, judgeQueue } = createDependencies({ settings, stats, queueError });
    const response = await invoke(dependencies, commandInteraction({ name: '심사' }));
    const body = messageResponseSchema.parse(JSON.parse(response.body ?? ''));

    expect(judgeQueue.enqueue).toHaveBeenCalledOnce();
    expect(body.type).toBe(4);
    expect(body.data.content).not.toContain(queueError.message);
    expect(body.data.content).toContain('요청을 처리하지 못했습니다.');
  });

  it('claims an owner-bound button once and enqueues only the thread judge job', async () => {
    const { dependencies, repository, judgeQueue } = createDependencies({
      settings,
      session: threadSession,
    });
    const response = await invoke(dependencies, componentInteraction());

    expect(repository.claimThreadReview).toHaveBeenCalledWith({
      guildId,
      sessionId: interactionId,
      ownerId: userId,
      anchorMessageId: interactionId,
      now: fixedNow.toISOString(),
    });
    expect(judgeQueue.enqueue).toHaveBeenCalledWith({
      kind: 'judge_thread',
      guildId,
      sessionId: interactionId,
      userId,
    });
    expect(JSON.parse(response.body ?? '')).toEqual({
      type: 7,
      data: {
        content: '**심사 중**\n스레드의 현재 학습 내용을 확인하고 있습니다.',
        components: [],
      },
    });
  });

  it('fails closed for another user and duplicate claims without enqueuing AI work', async () => {
    const otherUserId = '1541459000000000099';
    const denied = createDependencies({ settings, session: threadSession });
    const deniedResponse = await invoke(
      denied.dependencies,
      componentInteraction({ actorId: otherUserId }),
    );
    expect(JSON.parse(deniedResponse.body ?? '')).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(denied.judgeQueue.enqueue).not.toHaveBeenCalled();

    const duplicate = createDependencies({ settings, session: threadSession, claimed: false });
    const duplicateResponse = await invoke(duplicate.dependencies, componentInteraction());
    expect(JSON.parse(duplicateResponse.body ?? '')).toMatchObject({
      type: 4,
      data: { flags: 64 },
    });
    expect(duplicate.judgeQueue.enqueue).not.toHaveBeenCalled();
  });

  it('reopens the conditional claim when button job enqueue fails', async () => {
    const queueError = new Error('sensitive queue detail');
    const { dependencies, repository } = createDependencies({
      settings,
      session: threadSession,
      queueError,
    });
    const response = await invoke(dependencies, componentInteraction());

    expect(repository.reopenThreadReview).toHaveBeenCalledWith({
      guildId,
      sessionId: interactionId,
      expectedState: 'queued',
    });
    expect(JSON.parse(response.body ?? '')).toMatchObject({ type: 4, data: { flags: 64 } });
  });
});
