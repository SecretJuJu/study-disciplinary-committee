import { parseJudgment, judgeRequest } from '@disciplinary-committee/ai-judge';
import type { GuildSettings, Judgment, UserStats } from '@disciplinary-committee/domain';
import { diagnosticForFailure } from '@disciplinary-committee/domain';
import type {
  FinalizeThreadJudgmentInput,
  ThreadReviewSession,
} from '@disciplinary-committee/persistence';

import type { DiagnosticReporter } from './diagnostics.js';
import type { ModelClient } from './judge.js';
import {
  creditExhaustedMessage,
  NonRetryableModelError,
  RetryableModelError,
} from './model-errors.js';
import type { PrepareReviewJob, ThreadReviewJob } from './review-jobs.js';
import { threadReviewJobSchema } from './review-jobs.js';

export const reviewSnapshotCharacterLimit = 6_000;
const reviewMessageLimit = 100;
const judgingLeaseMilliseconds = 8 * 60 * 1_000;

export type DiscordThreadMessage = {
  id: string;
  type: number;
  content: string;
  timestamp: string;
  author: { id: string; bot?: boolean | undefined };
};

export type DiscordThreadClient = {
  getOriginalMessage(input: {
    applicationId: string;
    interactionToken: string;
  }): Promise<{ id: string; channelId: string }>;
  ensurePublicThread(input: {
    channelId: string;
    messageId: string;
    name: string;
  }): Promise<{ id: string } | undefined>;
  editOriginal(input: {
    applicationId: string;
    interactionToken: string;
    content: string;
  }): Promise<void>;
  editChannelMessage(input: {
    channelId: string;
    messageId: string;
    content: string;
    components?: readonly unknown[];
  }): Promise<void>;
  listThreadMessages(threadId: string): Promise<readonly DiscordThreadMessage[]>;
};

export type ThreadReviewRepository = {
  getThreadReview(guildId: string, sessionId: string): Promise<ThreadReviewSession | undefined>;
  bindThreadReview(input: {
    guildId: string;
    sessionId: string;
    ownerId: string;
    channelId: string;
    anchorMessageId: string;
    threadId: string;
  }): Promise<void>;
  claimThreadReviewForJudging(input: {
    guildId: string;
    sessionId: string;
    now: string;
    leaseUntil: string;
  }): Promise<ThreadReviewSession | undefined>;
  reopenThreadReview(input: {
    guildId: string;
    sessionId: string;
    expectedState: 'queued' | 'judging';
  }): Promise<void>;
  releaseThreadReview(input: { guildId: string; sessionId: string }): Promise<void>;
  cancelThreadReview(input: { guildId: string; sessionId: string }): Promise<void>;
  getGuildSettings(guildId: string): Promise<GuildSettings | undefined>;
  getUserStats(guildId: string, userId: string): Promise<UserStats | undefined>;
  getFinalizedJudgment(sessionId: string, userId: string): Promise<Judgment | undefined>;
  finalizeThreadJudgment(input: FinalizeThreadJudgmentInput): Promise<void>;
};

export function reviewButtonComponents(sessionId: string): readonly unknown[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: '심사 요청',
          emoji: { name: '⚖️' },
          custom_id: `review_submit:${sessionId}`,
        },
      ],
    },
  ];
}

function limitCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

export function snapshotOwnerMessages(
  messages: readonly DiscordThreadMessage[],
  ownerId: string,
  claimedAt?: string,
): string {
  const cutoff = claimedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(claimedAt);
  const content = messages
    .filter(
      (message) =>
        message.type === 0 &&
        message.author.id === ownerId &&
        message.author.bot !== true &&
        message.content.trim().length > 0 &&
        Date.parse(message.timestamp) <= cutoff,
    )
    .toSorted((left, right) => {
      const timeDifference = Date.parse(left.timestamp) - Date.parse(right.timestamp);
      return timeDifference === 0
        ? left.id.localeCompare(right.id, 'en', { numeric: true })
        : timeDifference;
    })
    .slice(-reviewMessageLimit)
    .map((message) => message.content.trim())
    .join('\n\n');
  return limitCharacters(content, reviewSnapshotCharacterLimit).trim();
}

function draftContent(session: ThreadReviewSession, note?: string): string {
  return [
    '**학습 심사 접수**',
    `<@${session.ownerId}> 님은 <#${session.threadId}> 스레드에 학습 내용을 작성해주세요.`,
    '작성 후 아래 `⚖️ 심사 요청` 버튼을 누르면 현재 내용만 심사합니다.',
    note,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function finalContent(judgment: Judgment): string {
  return ['**심사 결과**', judgment.verdictText, '', `판정 근거: ${judgment.rationale}`].join('\n');
}

const cancelledContent =
  '서버 심사 설정이 접수 후 변경되어 이 요청을 취소했습니다. 현재 설정된 제출 채널에서 새 `/심사`를 실행해주세요.';

function initialStats(userId: string): UserStats {
  return {
    userId,
    totalReviews: 0,
    meaningfulReviews: 0,
    insufficientReviews: 0,
    meaninglessReviews: 0,
    absentReviews: 0,
    disciplinaryPoints: 0,
    currentSurvivalStreak: 0,
    bestSurvivalStreak: 0,
  };
}

function isTransactionConflict(error: unknown): boolean {
  return error instanceof Error && error.name === 'TransactionCanceledException';
}

export class ThreadReviewWorker {
  public constructor(
    private readonly model: ModelClient,
    private readonly repository: ThreadReviewRepository,
    private readonly discord: DiscordThreadClient,
    private readonly diagnostics?: DiagnosticReporter,
  ) {}

  public async process(rawJob: unknown, now = new Date()): Promise<void> {
    const job = threadReviewJobSchema.parse(rawJob);
    try {
      if (job.kind === 'prepare_review') {
        await this.prepare(job);
      } else {
        await this.judge(job, now);
      }
    } catch (error) {
      await this.reportFailure(error, job.sessionId);
      throw error;
    }
  }

  private async prepare(job: PrepareReviewJob): Promise<void> {
    let session = await this.repository.getThreadReview(job.guildId, job.sessionId);
    if (
      session === undefined ||
      session.ownerId !== job.userId ||
      session.channelId !== job.channelId
    ) {
      throw new TypeError('Thread review preparation binding is invalid');
    }
    if (session.state !== 'draft') {
      return;
    }

    if (session.anchorMessageId === undefined || session.threadId === undefined) {
      const original = await this.discord.getOriginalMessage({
        applicationId: job.applicationId,
        interactionToken: job.interactionToken,
      });
      if (original.channelId !== job.channelId) {
        throw new TypeError('Original interaction channel does not match review session');
      }
      const thread = await this.discord.ensurePublicThread({
        channelId: job.channelId,
        messageId: original.id,
        name: `학습-심사-${job.userId.slice(-6)}`,
      });
      if (thread === undefined) {
        await this.discord.editOriginal({
          applicationId: job.applicationId,
          interactionToken: job.interactionToken,
          content:
            '이 채널에서 공개 스레드를 만들 권한이 없습니다. 관리자에게 제출 채널의 `Create Public Threads`, `Send Messages in Threads`, `Read Message History` 권한을 확인해달라고 요청한 뒤 새 `/심사`를 실행해주세요.',
        });
        return;
      }
      await this.repository.bindThreadReview({
        guildId: job.guildId,
        sessionId: job.sessionId,
        ownerId: job.userId,
        channelId: job.channelId,
        anchorMessageId: original.id,
        threadId: thread.id,
      });
      session = {
        ...session,
        anchorMessageId: original.id,
        threadId: thread.id,
      };
    }

    const anchorMessageId = session.anchorMessageId;
    if (anchorMessageId === undefined) {
      throw new TypeError('Prepared thread review is missing an anchor message');
    }
    await this.discord.editChannelMessage({
      channelId: session.channelId,
      messageId: anchorMessageId,
      content: draftContent(session),
      components: reviewButtonComponents(session.sessionId),
    });
  }

  private async judge(
    job: Extract<ThreadReviewJob, { kind: 'judge_thread' }>,
    now: Date,
  ): Promise<void> {
    const nowIso = now.toISOString();
    const session = await this.repository.claimThreadReviewForJudging({
      guildId: job.guildId,
      sessionId: job.sessionId,
      now: nowIso,
      leaseUntil: new Date(now.getTime() + judgingLeaseMilliseconds).toISOString(),
    });
    if (session === undefined) {
      const existing = await this.repository.getThreadReview(job.guildId, job.sessionId);
      const verdict = await this.repository.getFinalizedJudgment(job.sessionId, job.userId);
      if (
        existing?.state === 'finalized' &&
        existing.anchorMessageId !== undefined &&
        verdict !== undefined
      ) {
        await this.discord.editChannelMessage({
          channelId: existing.channelId,
          messageId: existing.anchorMessageId,
          content: finalContent(verdict),
          components: [],
        });
      } else if (
        existing?.state === 'draft' &&
        existing.anchorMessageId !== undefined &&
        existing.threadId !== undefined
      ) {
        await this.discord.editChannelMessage({
          channelId: existing.channelId,
          messageId: existing.anchorMessageId,
          content: draftContent(existing),
          components: reviewButtonComponents(existing.sessionId),
        });
      } else if (existing?.state === 'cancelled' && existing.anchorMessageId !== undefined) {
        await this.discord.editChannelMessage({
          channelId: existing.channelId,
          messageId: existing.anchorMessageId,
          content: cancelledContent,
          components: [],
        });
      }
      return;
    }
    if (
      session.ownerId !== job.userId ||
      session.anchorMessageId === undefined ||
      session.threadId === undefined
    ) {
      await this.releaseSafely(session);
      throw new TypeError('Claimed thread review is not fully bound');
    }

    try {
      const settings = await this.repository.getGuildSettings(job.guildId);
      if (
        settings === undefined ||
        !settings.enabled ||
        settings.submissionChannelId !== session.channelId ||
        settings.configVersion !== session.configVersion
      ) {
        await this.repository.cancelThreadReview({
          guildId: session.guildId,
          sessionId: session.sessionId,
        });
        await this.discord.editChannelMessage({
          channelId: session.channelId,
          messageId: session.anchorMessageId,
          content: cancelledContent,
          components: [],
        });
        return;
      }
      const snapshot = snapshotOwnerMessages(
        await this.discord.listThreadMessages(session.threadId),
        session.ownerId,
        session.claimedAt,
      );
      if (snapshot.length === 0) {
        await this.repository.reopenThreadReview({
          guildId: session.guildId,
          sessionId: session.sessionId,
          expectedState: 'judging',
        });
        await this.discord.editChannelMessage({
          channelId: session.channelId,
          messageId: session.anchorMessageId,
          content: draftContent(
            session,
            '⚠️ 심사할 텍스트가 없습니다. 내용을 작성한 뒤 다시 눌러주세요.',
          ),
          components: reviewButtonComponents(session.sessionId),
        });
        return;
      }

      const currentStats =
        (await this.repository.getUserStats(job.guildId, job.userId)) ?? initialStats(job.userId);
      const response = await this.model.create(
        judgeRequest({
          submission: { whatStudied: snapshot },
          disciplinaryPoints: currentStats.disciplinaryPoints,
        }),
      );
      let judgment: Judgment;
      try {
        judgment = parseJudgment(response.outputText);
      } catch (error) {
        throw new RetryableModelError('ai_output_invalid', { cause: error });
      }
      const finalized = await this.finalize(session, settings, currentStats, judgment, nowIso);
      await this.discord.editChannelMessage({
        channelId: session.channelId,
        messageId: session.anchorMessageId,
        content: finalContent(finalized),
        components: [],
      });
    } catch (error) {
      if (error instanceof NonRetryableModelError) {
        await this.reportFailure(error, session.sessionId);
        await this.repository.reopenThreadReview({
          guildId: session.guildId,
          sessionId: session.sessionId,
          expectedState: 'judging',
        });
        await this.discord.editChannelMessage({
          channelId: session.channelId,
          messageId: session.anchorMessageId,
          content: `${creditExhaustedMessage}\n기존 스레드 내용은 유지됩니다. 충전 후 다시 요청하세요.`,
          components: reviewButtonComponents(session.sessionId),
        });
        return;
      }
      await this.releaseSafely(session);
      try {
        await this.discord.editChannelMessage({
          channelId: session.channelId,
          messageId: session.anchorMessageId,
          content: '심사 처리 중 일시적인 오류가 발생해 자동 재시도합니다.',
          components: [],
        });
      } catch {
        // 안정 메시지 게시 실패는 원래 SQS 재시도를 숨기지 않는다.
      }
      throw error;
    }
  }

  private async finalize(
    session: ThreadReviewSession,
    settings: GuildSettings,
    stats: UserStats,
    judgment: Judgment,
    finalizedAt: string,
  ): Promise<Judgment> {
    const persist = (currentStats: UserStats): Promise<void> =>
      this.repository.finalizeThreadJudgment({
        guildId: session.guildId,
        sessionId: session.sessionId,
        userId: session.ownerId,
        stats: currentStats,
        judgment,
        scorePolicy: settings.scorePolicy,
        finalizedAt,
      });
    try {
      await persist(stats);
      return judgment;
    } catch (error) {
      if (!isTransactionConflict(error)) {
        throw error;
      }
      const existing = await this.repository.getFinalizedJudgment(
        session.sessionId,
        session.ownerId,
      );
      if (existing !== undefined) {
        return existing;
      }
      const refreshed = await this.repository.getUserStats(session.guildId, session.ownerId);
      if (refreshed === undefined) {
        throw error;
      }
      await persist(refreshed);
      return judgment;
    }
  }

  private async releaseSafely(session: ThreadReviewSession): Promise<void> {
    try {
      await this.repository.releaseThreadReview({
        guildId: session.guildId,
        sessionId: session.sessionId,
      });
    } catch {
      // lease 만료 후 다른 worker가 소유권을 얻은 경우 현재 worker는 상태를 덮어쓰지 않는다.
    }
  }

  private async reportFailure(error: unknown, sessionId: string): Promise<void> {
    if (this.diagnostics === undefined) {
      return;
    }
    try {
      await this.diagnostics.report(
        diagnosticForFailure({
          component: 'judge',
          correlationId: `session:${sessionId}`,
          error,
        }),
      );
    } catch {
      // 운영 알림 장애는 원래 작업 처리를 바꾸지 않는다.
    }
  }
}
