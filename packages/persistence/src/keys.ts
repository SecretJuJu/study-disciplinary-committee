export const guildPk = (guildId: string): string => `GUILD#${guildId}`;
export const settingsSk = (): 'SETTINGS' => 'SETTINGS';
export const sessionPk = (sessionId: string): string => `SESSION#${sessionId}`;
export const sessionSk = (sessionId: string): string => `SESSION#${sessionId}`;
export const submissionSk = (userId: string): string => `SUBMISSION#${userId}`;
export const verdictSk = (userId: string): string => `VERDICT#${userId}`;
export const userSk = (userId: string): string => `USER#${userId}`;
export const idempotencyPk = (source: string): string => `IDEMPOTENCY#${source}`;
