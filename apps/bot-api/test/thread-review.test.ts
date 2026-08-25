import {
  defaultScorePolicy,
  type GuildSettings,
  type Judgment,
  type UserStats,
} from '@disciplinary-committee/domain';
import type { ThreadReviewSession } from '@disciplinary-committee/persistence';
import { describe, expect, it, vi } from 'vitest';

import { NonRetryableModelError } from '../src/model-errors.js';
import type { ModelClient } from '../src/judge.js';
import type { JudgeThreadJob, PrepareReviewJob } from '../src/review-jobs.js';
import {
  reviewSnapshotCharacterLimit,
  snapshotOwnerMessages,
  ThreadReviewWorker,
  type DiscordThreadClient,
  type DiscordThreadMessage,
  type ThreadReviewRepository,
} from '../src/thread-review.js';

const guildId = '1541458098101952522';
const ownerId = '1541459000000000003';
const sessionId = '1541459000000000001';
const channelId = '1541458116195917935';
const anchorMessageId = '1541459000000000008';
const threadId = '1541459000000000009';
const fixedNow = new Date('2026-08-25T00:00:00.000Z');

const session: ThreadReviewSession = {
  sessionId,
  guildId,
  ownerId,
  channelId,
  state: 'judging',
  createdAt: '2026-08-24T23:55:00.000Z',
  deadlineAt: '2026-08-25T00:30:00.000Z',
  expiresAt: 1_795_392_000,
  configVersion: 4,
  anchorMessageId,
  threadId,
  leaseUntil: '2026-08-25T00:08:00.000Z',
  claimedAt: '2026-08-25T00:00:00.000Z',
};

const settings: GuildSettings = {
  guildId,
  enabled: true,
  timezone: 'Asia/Seoul',
  cadenceMinutes: 1_440,
  submissionWindowMinutes: 30,
  submissionChannelId: channelId,
  verdictChannelId: channelId,
  roleChangesEnabled: false,
  scorePolicy: defaultScorePolicy,
  thresholds: { observationAt: 3, disciplinaryAt: 5, severeAt: 8 },
  configVersion: 4,
};

const stats: UserStats = {
  userId: ownerId,
  totalReviews: 0,
  meaningfulReviews: 0,
  insufficientReviews: 0,
  meaninglessReviews: 0,
  absentReviews: 0,
  disciplinaryPoints: 0,
  currentSurvivalStreak: 0,
  bestSurvivalStreak: 0,
};

const judgment: Judgment = {
  outcome: 'meaningful',
  rationale: '구체적인 학습 활동이 확인됩니다.',
  verdictText: '유의미한 학습으로 인정합니다.',
  confidence: 'high',
};

const judgeJob: JudgeThreadJob = { kind: 'judge_thread', guildId, sessionId, userId: ownerId };

function message(input: Partial<DiscordThreadMessage> & { content: string }): DiscordThreadMessage {
  return {
    id: input.id ?? '1541459000000000011',
    type: input.type ?? 0,
    content: input.content,
    timestamp: input.timestamp ?? '2026-08-25T00:00:00.000Z',
    author: input.author ?? { id: ownerId },
  };
}

function repository(overrides: Partial<ThreadReviewRepository> = {}): ThreadReviewRepository {
  return {
    getThreadReview: async () => session,
    bindThreadReview: async () => undefined,
    claimThreadReviewForJudging: async () => session,
    reopenThreadReview: async () => undefined,
    releaseThreadReview: async () => undefined,
    cancelThreadReview: async () => undefined,
    getGuildSettings: async () => settings,
    getUserStats: async () => stats,
    getFinalizedJudgment: async () => undefined,
    finalizeThreadJudgment: async () => undefined,
    ...overrides,
  };
}

function discord(overrides: Partial<DiscordThreadClient> = {}): DiscordThreadClient {
  return {
    getOriginalMessage: async () => ({ id: anchorMessageId, channelId }),
    ensurePublicThread: async () => ({ id: threadId }),
    editOriginal: async () => undefined,
    editChannelMessage: async () => undefined,
    listThreadMessages: async () => [message({ content: 'TypeScript 경계 테스트를 작성했다.' })],
    ...overrides,
  };
}

function model() {
  return {
    create: vi.fn<ModelClient['create']>(async () => ({ outputText: JSON.stringify(judgment) })),
  };
}

describe('owner message snapshot', () => {
  it('uses only owner normal non-bot text in oldest-first order', () => {
    const snapshot = snapshotOwnerMessages(
      [
        message({
          id: '1541459000000000015',
          content: '둘째',
          timestamp: '2026-08-24T23:59:00.000Z',
        }),
        message({
          id: '1541459000000000014',
          content: '다른 사람',
          author: { id: '1541459000000000099' },
        }),
        message({ id: '1541459000000000013', content: '봇', author: { id: ownerId, bot: true } }),
        message({ id: '1541459000000000012', content: '시스템', type: 18 }),
        message({
          id: '1541459000000000011',
          content: '  첫째  ',
          timestamp: '2026-08-24T23:58:00.000Z',
        }),
        message({ id: '1541459000000000016', content: '   ' }),
      ],
      ownerId,
      '2026-08-25T00:00:00.000Z',
    );

    expect(snapshot).toBe('첫째\n\n둘째');
  });

  it('excludes messages written after the button claim timestamp', () => {
    const snapshot = snapshotOwnerMessages(
      [
        message({ content: '버튼 전', timestamp: '2026-08-24T23:59:59.000Z' }),
        message({ content: '버튼 후', timestamp: '2026-08-25T00:00:01.000Z' }),
      ],
      ownerId,
      '2026-08-25T00:00:00.000Z',
    );
    expect(snapshot).toBe('버튼 전');
  });

  it('bounds the current snapshot to 6,000 Unicode characters', () => {
    const snapshot = snapshotOwnerMessages([message({ content: '가'.repeat(7_000) })], ownerId);
    expect(Array.from(snapshot)).toHaveLength(reviewSnapshotCharacterLimit);
  });

  it('keeps the latest 100 owner messages after filtering bounded public-thread noise', () => {
    const otherUserId = '1541459000000000099';
    const messages = [
      ...Array.from({ length: 100 }, (_, index) =>
        message({
          id: String(1541459000000000200n + BigInt(index)),
          content: `다른 사용자 ${index}`,
          author: { id: otherUserId },
        }),
      ),
      message({ id: '1541459000000000009', content: '소유자 학습 내용' }),
    ];

    expect(snapshotOwnerMessages(messages, ownerId)).toBe('소유자 학습 내용');
  });
});

describe('ThreadReviewWorker', () => {
  it('rejects malformed queue jobs before touching persistence or Discord', async () => {
    const getThreadReview = vi.fn<ThreadReviewRepository['getThreadReview']>();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const worker = new ThreadReviewWorker(
      model(),
      repository({ getThreadReview }),
      discord({ editChannelMessage }),
    );

    await expect(worker.process({ ...judgeJob, unexpected: true }, fixedNow)).rejects.toThrow();
    expect(getThreadReview).not.toHaveBeenCalled();
    expect(editChannelMessage).not.toHaveBeenCalled();
  });

  it('prepares and binds a public thread before adding the review button', async () => {
    const draft = {
      ...session,
      state: 'draft' as const,
      anchorMessageId: undefined,
      threadId: undefined,
    };
    const bindThreadReview = vi.fn<ThreadReviewRepository['bindThreadReview']>();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const worker = new ThreadReviewWorker(
      model(),
      repository({ getThreadReview: async () => draft, bindThreadReview }),
      discord({ editChannelMessage }),
    );
    const job: PrepareReviewJob = {
      kind: 'prepare_review',
      guildId,
      sessionId,
      userId: ownerId,
      channelId,
      applicationId: '1541457217830522940',
      interactionToken: 'token',
    };

    await worker.process(job, fixedNow);

    expect(bindThreadReview).toHaveBeenCalledWith({
      guildId,
      sessionId,
      ownerId,
      channelId,
      anchorMessageId,
      threadId,
    });
    expect(editChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId,
        messageId: anchorMessageId,
        components: expect.arrayContaining([expect.any(Object)]),
      }),
    );
  });

  it('ends preparation with an actionable message when the channel cannot create threads', async () => {
    const draft = {
      ...session,
      state: 'draft' as const,
      anchorMessageId: undefined,
      threadId: undefined,
    };
    const bindThreadReview = vi.fn<ThreadReviewRepository['bindThreadReview']>();
    const editOriginal = vi.fn<DiscordThreadClient['editOriginal']>();
    const worker = new ThreadReviewWorker(
      model(),
      repository({ getThreadReview: async () => draft, bindThreadReview }),
      discord({ ensurePublicThread: async () => undefined, editOriginal }),
    );

    await worker.process(
      {
        kind: 'prepare_review',
        guildId,
        sessionId,
        userId: ownerId,
        channelId,
        applicationId: '1541457217830522940',
        interactionToken: 'token',
      },
      fixedNow,
    );

    expect(bindThreadReview).not.toHaveBeenCalled();
    expect(editOriginal).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Create Public Threads') }),
    );
  });

  it('reopens an empty submission with a button and does not call AI', async () => {
    const reopenThreadReview = vi.fn<ThreadReviewRepository['reopenThreadReview']>();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const modelClient = model();
    const worker = new ThreadReviewWorker(
      modelClient,
      repository({ reopenThreadReview }),
      discord({ listThreadMessages: async () => [], editChannelMessage }),
    );

    await worker.process(judgeJob, fixedNow);

    expect(modelClient.create).not.toHaveBeenCalled();
    expect(reopenThreadReview).toHaveBeenCalledWith({
      guildId,
      sessionId,
      expectedState: 'judging',
    });
    expect(editChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('심사할 텍스트가 없습니다') }),
    );
  });

  it('cancels without retrying when guild settings changed after the button claim', async () => {
    const cancelThreadReview = vi.fn<ThreadReviewRepository['cancelThreadReview']>();
    const releaseThreadReview = vi.fn<ThreadReviewRepository['releaseThreadReview']>();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const modelClient = model();
    const worker = new ThreadReviewWorker(
      modelClient,
      repository({
        getGuildSettings: async () => ({ ...settings, configVersion: settings.configVersion + 1 }),
        cancelThreadReview,
        releaseThreadReview,
      }),
      discord({ editChannelMessage }),
    );

    await expect(worker.process(judgeJob, fixedNow)).resolves.toBeUndefined();
    expect(cancelThreadReview).toHaveBeenCalledWith({ guildId, sessionId });
    expect(releaseThreadReview).not.toHaveBeenCalled();
    expect(modelClient.create).not.toHaveBeenCalled();
    expect(editChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('설정이 접수 후 변경') }),
    );
  });

  it('sends only the bounded current snapshot to AI, finalizes once, and edits the stable anchor', async () => {
    const finalizeThreadJudgment = vi.fn<ThreadReviewRepository['finalizeThreadJudgment']>();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const modelClient = model();
    const worker = new ThreadReviewWorker(
      modelClient,
      repository({ finalizeThreadJudgment }),
      discord({ editChannelMessage }),
    );

    await worker.process(judgeJob, fixedNow);

    const request = modelClient.create.mock.calls[0]?.[0];
    expect(request?.input).toContain('TypeScript 경계 테스트를 작성했다.');
    expect(request?.input).not.toContain('previous_response_id');
    expect(finalizeThreadJudgment).toHaveBeenCalledOnce();
    expect(editChannelMessage).toHaveBeenLastCalledWith({
      channelId,
      messageId: anchorMessageId,
      content: expect.stringContaining(judgment.verdictText),
      components: [],
    });
  });

  it('avoids duplicate AI and republishes an already finalized verdict', async () => {
    const modelClient = model();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const worker = new ThreadReviewWorker(
      modelClient,
      repository({
        claimThreadReviewForJudging: async () => undefined,
        getThreadReview: async () => ({ ...session, state: 'finalized' }),
        getFinalizedJudgment: async () => judgment,
      }),
      discord({ editChannelMessage }),
    );

    await worker.process(judgeJob, fixedNow);

    expect(modelClient.create).not.toHaveBeenCalled();
    expect(editChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: anchorMessageId,
        content: expect.stringContaining(judgment.verdictText),
      }),
    );
  });

  it('republishes deterministic cancellation after a transient anchor edit failure', async () => {
    const modelClient = model();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const worker = new ThreadReviewWorker(
      modelClient,
      repository({
        claimThreadReviewForJudging: async () => undefined,
        getThreadReview: async () => ({ ...session, state: 'cancelled' }),
      }),
      discord({ editChannelMessage }),
    );

    await worker.process(judgeJob, fixedNow);

    expect(modelClient.create).not.toHaveBeenCalled();
    expect(editChannelMessage).toHaveBeenCalledWith({
      channelId,
      messageId: anchorMessageId,
      content: expect.stringContaining('설정이 접수 후 변경'),
      components: [],
    });
  });

  it('reopens credit exhaustion and reports through the stable anchor without retrying', async () => {
    const reopenThreadReview = vi.fn<ThreadReviewRepository['reopenThreadReview']>();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const worker = new ThreadReviewWorker(
      { create: async () => Promise.reject(new NonRetryableModelError()) },
      repository({ reopenThreadReview }),
      discord({ editChannelMessage }),
    );

    await expect(worker.process(judgeJob, fixedNow)).resolves.toBeUndefined();
    expect(reopenThreadReview).toHaveBeenCalledWith({
      guildId,
      sessionId,
      expectedState: 'judging',
    });
    expect(editChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: anchorMessageId,
        content: expect.stringContaining('크레딧'),
      }),
    );
  });

  it('releases retryable failures and updates the stable anchor with a safe status', async () => {
    const releaseThreadReview = vi.fn<ThreadReviewRepository['releaseThreadReview']>();
    const editChannelMessage = vi.fn<DiscordThreadClient['editChannelMessage']>();
    const worker = new ThreadReviewWorker(
      { create: async () => Promise.reject(new Error('sensitive upstream detail')) },
      repository({ releaseThreadReview }),
      discord({ editChannelMessage }),
    );

    await expect(worker.process(judgeJob, fixedNow)).rejects.toThrow('sensitive upstream detail');
    expect(releaseThreadReview).toHaveBeenCalledWith({ guildId, sessionId });
    expect(editChannelMessage).toHaveBeenCalledWith({
      channelId,
      messageId: anchorMessageId,
      content: '심사 처리 중 일시적인 오류가 발생해 자동 재시도합니다.',
      components: [],
    });
  });
});
