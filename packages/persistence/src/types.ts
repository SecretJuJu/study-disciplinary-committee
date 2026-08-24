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
};

export type UserStatsRecord = UserStats & {
  PK: string;
  SK: string;
  entityType: 'UserStats';
  guildId: string;
};
