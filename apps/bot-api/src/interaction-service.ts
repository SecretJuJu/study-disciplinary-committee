import {
  commandHelp,
  deferredChannelMessageResponse,
  ephemeralMessageResponse,
  hasManageGuildPermission,
  parseApplicationCommand,
  type DiscordInteraction,
} from '@disciplinary-committee/discord';
import {
  defaultDisciplinaryThresholds,
  defaultScorePolicy,
  submissionInputSchema,
  type GuildSettings,
  type UserStats,
} from '@disciplinary-committee/domain';
import type {
  CreateAdHocReviewInput,
  SaveGuildSettingsInput,
} from '@disciplinary-committee/persistence';

import type { JudgeJob } from './judge.js';

const submissionRetentionSeconds = 90 * 24 * 60 * 60;

export type InteractionRepository = {
  getGuildSettings(guildId: string): Promise<GuildSettings | undefined>;
  saveGuildSettings(input: SaveGuildSettingsInput): Promise<void>;
  getUserStats(guildId: string, userId: string): Promise<UserStats | undefined>;
  createAdHocReview(input: CreateAdHocReviewInput): Promise<void>;
};

export type JudgeQueue = {
  enqueue(job: JudgeJob): Promise<void>;
};

export type InteractionDependencies = {
  repository: InteractionRepository;
  judgeQueue: JudgeQueue;
  now(): Date;
};

type InteractionResponse =
  typeof deferredChannelMessageResponse | ReturnType<typeof ephemeralMessageResponse>;

function guildContext(
  interaction: DiscordInteraction,
): { guildId: string; userId: string } | undefined {
  const guildId = interaction.guild_id;
  const userId = interaction.member?.user.id;
  return guildId === undefined || userId === undefined ? undefined : { guildId, userId };
}

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

function settingsForSave(input: {
  guildId: string;
  submissionChannelId: string;
  verdictChannelId: string;
  existing?: GuildSettings;
}): GuildSettings {
  if (input.existing !== undefined) {
    return {
      ...input.existing,
      submissionChannelId: input.submissionChannelId,
      verdictChannelId: input.verdictChannelId,
      configVersion: input.existing.configVersion + 1,
    };
  }

  return {
    guildId: input.guildId,
    enabled: true,
    timezone: 'Asia/Seoul',
    cadenceMinutes: 1_440,
    submissionWindowMinutes: 60,
    submissionChannelId: input.submissionChannelId,
    verdictChannelId: input.verdictChannelId,
    roleChangesEnabled: false,
    scorePolicy: defaultScorePolicy,
    thresholds: defaultDisciplinaryThresholds,
    configVersion: 1,
  };
}

function formatSettings(settings: GuildSettings): string {
  return [
    '**현재 서버 설정**',
    `상태: ${settings.enabled ? '사용 중' : '중지'}`,
    `제출 채널: <#${settings.submissionChannelId}>`,
    `판결 채널: <#${settings.verdictChannelId}>`,
    `시간대: ${settings.timezone}`,
    `제출 유효 시간: ${settings.submissionWindowMinutes}분`,
    `역할 자동 변경: ${settings.roleChangesEnabled ? '사용' : '사용 안 함'}`,
    `설정 버전: ${settings.configVersion}`,
  ].join('\n');
}

function formatStats(stats: UserStats): string {
  return [
    '**내 심사 기록**',
    `전체 심사: ${stats.totalReviews}회`,
    `유의미: ${stats.meaningfulReviews}회`,
    `미흡: ${stats.insufficientReviews}회`,
    `무의미: ${stats.meaninglessReviews}회`,
    `불출석: ${stats.absentReviews}회`,
    `누적 징계 점수: ${stats.disciplinaryPoints}점`,
    `현재/최고 생존 연속: ${stats.currentSurvivalStreak}/${stats.bestSurvivalStreak}회`,
  ].join('\n');
}

export async function routeApplicationCommand(
  interaction: DiscordInteraction,
  dependencies: InteractionDependencies,
): Promise<InteractionResponse> {
  const command = parseApplicationCommand(interaction);
  if (command.name === 'help') {
    return ephemeralMessageResponse(commandHelp);
  }

  const context = guildContext(interaction);
  if (context === undefined) {
    return ephemeralMessageResponse('이 명령은 Discord 서버 안에서만 사용할 수 있습니다.');
  }

  if (command.name === '설정') {
    if (!hasManageGuildPermission(interaction)) {
      return ephemeralMessageResponse('서버 관리 권한이 필요합니다.');
    }

    const existing = await dependencies.repository.getGuildSettings(context.guildId);
    if (command.action === '보기') {
      return ephemeralMessageResponse(
        existing === undefined
          ? '저장된 설정이 없습니다. `/설정 저장`으로 제출 채널과 판결 채널을 지정해주세요.'
          : formatSettings(existing),
      );
    }

    const settings = settingsForSave({
      guildId: context.guildId,
      submissionChannelId: command.submissionChannelId,
      verdictChannelId: command.verdictChannelId,
      ...(existing === undefined ? {} : { existing }),
    });
    await dependencies.repository.saveGuildSettings({
      settings,
      ...(existing === undefined ? {} : { expectedConfigVersion: existing.configVersion }),
    });
    return ephemeralMessageResponse(
      `설정을 저장했습니다. 제출 채널 <#${settings.submissionChannelId}>, 판결 채널 <#${settings.verdictChannelId}> · 버전 ${settings.configVersion}`,
    );
  }

  if (command.name === '내기록') {
    const stats =
      (await dependencies.repository.getUserStats(context.guildId, context.userId)) ??
      initialStats(context.userId);
    return ephemeralMessageResponse(formatStats(stats));
  }

  const settings = await dependencies.repository.getGuildSettings(context.guildId);
  if (settings === undefined || !settings.enabled) {
    return ephemeralMessageResponse(
      '이 서버의 심사 설정이 아직 활성화되지 않았습니다. 관리자에게 `/설정 저장`을 요청해주세요.',
    );
  }

  const submission = submissionInputSchema.parse({
    whatStudied: command.studyContent,
    ...(command.durationMinutes === undefined ? {} : { duration: `${command.durationMinutes}분` }),
    ...(command.learnedText === undefined ? {} : { learned: command.learnedText }),
  });
  const stats =
    (await dependencies.repository.getUserStats(context.guildId, context.userId)) ??
    initialStats(context.userId);
  const now = dependencies.now();
  const submittedAt = now.toISOString();
  const deadlineAt = new Date(
    now.getTime() + settings.submissionWindowMinutes * 60 * 1_000,
  ).toISOString();
  const expiresAt = Math.floor(now.getTime() / 1_000) + submissionRetentionSeconds;

  await dependencies.repository.createAdHocReview({
    guildId: context.guildId,
    sessionId: interaction.id,
    userId: context.userId,
    content: JSON.stringify(submission),
    submittedAt,
    deadlineAt,
    expiresAt,
    configVersion: settings.configVersion,
  });
  await dependencies.judgeQueue.enqueue({
    guildId: context.guildId,
    sessionId: interaction.id,
    userId: context.userId,
    submission,
    stats,
    scorePolicy: settings.scorePolicy,
    interactionToken: interaction.token,
    applicationId: interaction.application_id,
  });

  return deferredChannelMessageResponse;
}
