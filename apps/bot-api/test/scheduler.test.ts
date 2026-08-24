import { describe, expect, it } from 'vitest';
import { SchedulerWorker } from '../src/scheduler.js';
describe('SchedulerWorker', () => {
  it('does not publish duplicate summons or stale configuration events', async () => {
    const sent: string[] = [];
    let opens = 0;
    const worker = new SchedulerWorker(
      {
        isCurrentConfig: async (_g, version) => version === 2,
        verdictChannelId: async () => '123456789012345678',
        openSession: async () => ({ created: ++opens === 1, content: '소환합니다.' }),
        finalizeAbsences: async () => ({ content: '불출석 처리했습니다.' }),
        buildWeeklySummary: async () => ({ content: '주간 결산' }),
      },
      {
        enqueue: async ({ content }) => {
          sent.push(content);
        },
      },
    );
    const job = {
      kind: 'summon',
      guildId: '123456789012345678',
      configVersion: 2,
      sessionId: 's1',
      occurredAt: '2026-08-24T12:00:00.000Z',
    };
    await worker.process(job);
    await worker.process(job);
    await worker.process({ ...job, configVersion: 1 });
    expect(sent).toEqual(['소환합니다.']);
  });
});
