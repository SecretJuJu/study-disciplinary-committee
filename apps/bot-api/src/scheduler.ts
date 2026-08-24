import { z } from 'zod';

import { diagnosticForFailure } from '@disciplinary-committee/domain';

import type { DiagnosticReporter } from './diagnostics.js';

const schedulerJobSchema = z
  .object({
    kind: z.enum(['summon', 'deadline', 'weekly_summary']),
    guildId: z.string().regex(/^\d{17,20}$/),
    configVersion: z.number().int().positive(),
    sessionId: z.string().min(1).max(128).optional(),
    occurredAt: z.string().datetime(),
  })
  .strict()
  .superRefine((job, context) => {
    if ((job.kind === 'summon' || job.kind === 'deadline') && job.sessionId === undefined) {
      context.addIssue({ code: 'custom', message: 'sessionId is required', path: ['sessionId'] });
    }
  });
export type SchedulerJob = z.infer<typeof schedulerJobSchema>;

export type SchedulerCoordinator = {
  isCurrentConfig(guildId: string, configVersion: number): Promise<boolean>;
  openSession(
    job: Extract<SchedulerJob, { kind: 'summon' }>,
  ): Promise<{ created: boolean; content: string }>;
  finalizeAbsences(job: Extract<SchedulerJob, { kind: 'deadline' }>): Promise<{ content: string }>;
  buildWeeklySummary(
    job: Extract<SchedulerJob, { kind: 'weekly_summary' }>,
  ): Promise<{ content: string }>;
  verdictChannelId(guildId: string): Promise<string>;
};
export type ScheduledOutbox = {
  enqueue(input: { channelId: string; content: string }): Promise<void>;
};

export class SchedulerWorker {
  public constructor(
    private readonly coordinator: SchedulerCoordinator,
    private readonly outbox: ScheduledOutbox,
    private readonly diagnostics?: DiagnosticReporter,
  ) {}
  public async process(rawJob: unknown): Promise<void> {
    let correlationId = 'scheduler:unknown';
    try {
      const job = schedulerJobSchema.parse(rawJob);
      correlationId = `scheduler:${job.kind}:${job.sessionId ?? job.occurredAt}`;
      if (!(await this.coordinator.isCurrentConfig(job.guildId, job.configVersion))) {
        return;
      }
      const channelId = await this.coordinator.verdictChannelId(job.guildId);
      if (job.kind === 'summon') {
        const result = await this.coordinator.openSession(
          job as Extract<SchedulerJob, { kind: 'summon' }>,
        );
        if (result.created) {
          await this.outbox.enqueue({ channelId, content: result.content });
        }
        return;
      }
      const result =
        job.kind === 'deadline'
          ? await this.coordinator.finalizeAbsences(
              job as Extract<SchedulerJob, { kind: 'deadline' }>,
            )
          : await this.coordinator.buildWeeklySummary(
              job as Extract<SchedulerJob, { kind: 'weekly_summary' }>,
            );
      await this.outbox.enqueue({ channelId, content: result.content });
    } catch (error) {
      await this.reportFailure(error, correlationId);
      throw error;
    }
  }

  private async reportFailure(error: unknown, correlationId: string): Promise<void> {
    if (this.diagnostics === undefined) {
      return;
    }
    try {
      await this.diagnostics.report(
        diagnosticForFailure({ component: 'scheduler', correlationId, error }),
      );
    } catch {
      // 오류 알림 자체의 장애는 Scheduler의 원래 재시도를 방해하지 않는다.
    }
  }
}
