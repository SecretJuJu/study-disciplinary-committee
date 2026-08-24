import { z } from 'zod';

const discordSnowflakeSchema = z.string().regex(/^\d{17,20}$/);
const nonNegativeIntegerSchema = z.number().int().nonnegative();

export const reviewOutcomeSchema = z.enum(['meaningful', 'insufficient', 'meaningless']);
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

export const reviewSessionStateSchema = z.enum([
  'scheduled',
  'open',
  'submitted',
  'judging',
  'finalized',
  'absent_finalized',
]);
export type ReviewSessionState = z.infer<typeof reviewSessionStateSchema>;

export const disciplinaryStatusSchema = z.enum([
  'normal',
  'observation',
  'disciplinary',
  'severe_disciplinary',
]);
export type DisciplinaryStatus = z.infer<typeof disciplinaryStatusSchema>;

export const scorePolicySchema = z
  .object({
    insufficient: z.number().int().min(0).max(3),
    meaningless: z.number().int().min(0).max(5),
    absent: z.number().int().min(0).max(5),
  })
  .strict();
export type ScorePolicy = z.infer<typeof scorePolicySchema>;

export const disciplinaryThresholdsSchema = z
  .object({
    observationAt: z.number().int().min(1),
    disciplinaryAt: z.number().int().min(2),
    severeAt: z.number().int().min(3),
  })
  .strict()
  .superRefine((thresholds, context) => {
    if (thresholds.observationAt >= thresholds.disciplinaryAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'observationAt must be lower than disciplinaryAt',
        path: ['observationAt'],
      });
    }

    if (thresholds.disciplinaryAt >= thresholds.severeAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'disciplinaryAt must be lower than severeAt',
        path: ['disciplinaryAt'],
      });
    }
  });
export type DisciplinaryThresholds = z.infer<typeof disciplinaryThresholdsSchema>;

export const guildSettingsSchema = z
  .object({
    guildId: discordSnowflakeSchema,
    enabled: z.boolean(),
    timezone: z.string().trim().min(1).max(64),
    cadenceMinutes: z.number().int().min(60).max(10_080),
    submissionWindowMinutes: z.number().int().min(5).max(1_440),
    submissionChannelId: discordSnowflakeSchema,
    verdictChannelId: discordSnowflakeSchema,
    targetRoleId: discordSnowflakeSchema.optional(),
    roleChangesEnabled: z.boolean(),
    scorePolicy: scorePolicySchema,
    thresholds: disciplinaryThresholdsSchema,
    configVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.roleChangesEnabled && settings.targetRoleId === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'targetRoleId is required when role changes are enabled',
        path: ['targetRoleId'],
      });
    }
  });
export type GuildSettings = z.infer<typeof guildSettingsSchema>;

export const submissionInputSchema = z
  .object({
    whatStudied: z.string().trim().min(1).max(2_000),
    duration: z.string().trim().min(1).max(100).optional(),
    learned: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type SubmissionInput = z.infer<typeof submissionInputSchema>;

export const judgmentSchema = z
  .object({
    outcome: reviewOutcomeSchema,
    rationale: z.string().trim().min(1).max(300),
    verdictText: z.string().trim().min(1).max(500),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export type Judgment = z.infer<typeof judgmentSchema>;

export const userStatsSchema = z
  .object({
    userId: discordSnowflakeSchema,
    totalReviews: nonNegativeIntegerSchema,
    meaningfulReviews: nonNegativeIntegerSchema,
    insufficientReviews: nonNegativeIntegerSchema,
    meaninglessReviews: nonNegativeIntegerSchema,
    absentReviews: nonNegativeIntegerSchema,
    disciplinaryPoints: nonNegativeIntegerSchema,
    currentSurvivalStreak: nonNegativeIntegerSchema,
    bestSurvivalStreak: nonNegativeIntegerSchema,
  })
  .strict();
export type UserStats = z.infer<typeof userStatsSchema>;

export const defaultScorePolicy: ScorePolicy = {
  insufficient: 0,
  meaningless: 2,
  absent: 3,
};

export const defaultDisciplinaryThresholds: DisciplinaryThresholds = {
  observationAt: 3,
  disciplinaryAt: 5,
  severeAt: 8,
};
