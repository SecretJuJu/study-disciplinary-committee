import type { GuildSettings, Judgment, UserStats } from '@disciplinary-committee/domain';

export type GuildSettingsRecord = GuildSettings & {
  PK: string;
  SK: 'SETTINGS';
  entityType: 'GuildSettings';
};

export type ReviewSessionRecord = {
  PK: string;
  SK: string;
  entityType: 'ReviewSession';
  sessionId: string;
  guildId: string;
  state: 'open' | 'submitted' | 'judging' | 'finalized' | 'absent_finalized';
  deadlineAt: string;
  expiresAt: number;
  configVersion: number;
};

export type ThreadReviewState = 'draft' | 'queued' | 'judging' | 'finalized' | 'cancelled';
export type ThreadReviewAction = 'initial' | 'appeal';

export type ThreadReviewSession = {
  sessionId: string;
  guildId: string;
  ownerId: string;
  channelId: string;
  state: ThreadReviewState;
  createdAt: string;
  deadlineAt: string;
  expiresAt: number;
  configVersion: number;
  anchorMessageId?: string | undefined;
  threadId?: string | undefined;
  leaseUntil?: string | undefined;
  claimedAt?: string | undefined;
  initialClaimedAt?: string | undefined;
  appealFromAt?: string | undefined;
  pendingAction?: ThreadReviewAction | undefined;
  appealsUsed?: number | undefined;
  pendingRequestId?: string | undefined;
  lastProcessedRequestId?: string | undefined;
};

export type ThreadReviewSessionRecord = ThreadReviewSession & {
  PK: string;
  SK: string;
  entityType: 'ThreadReviewSession';
};

export type SubmissionRecord = {
  PK: string;
  SK: string;
  entityType: 'Submission';
  sessionId: string;
  userId: string;
  revision: number;
  content: string;
  submittedAt: string;
  expiresAt: number;
};

export type VerdictRecord = {
  PK: string;
  SK: string;
  entityType: 'Verdict';
  sessionId: string;
  userId: string;
  judgment: Judgment | null;
  pointsDelta: number;
  finalizedAt: string;
  reason: 'judgment' | 'absence';
  revision?: number | undefined;
};

export type ThreadAppealRecord = {
  PK: string;
  SK: string;
  entityType: 'ThreadAppeal';
  sessionId: string;
  userId: string;
  appealNumber: number;
  previousJudgment: Judgment;
  judgment: Judgment;
  previousPointsDelta: number;
  pointsDelta: number;
  finalizedAt: string;
  expiresAt: number;
};

export type UserStatsRecord = UserStats & {
  PK: string;
  SK: string;
  entityType: 'UserStats';
  guildId: string;
};
