import { describe, expect, it } from 'vitest';

import { DiscordDiagnosticReporter } from '../src/diagnostics.js';

describe('DiscordDiagnosticReporter', () => {
  it('does not send when a debug channel is not configured', async () => {
    const sent: string[] = [];
    const logs: string[] = [];
    const reporter = new DiscordDiagnosticReporter(
      {
        sendMessage: async ({ content }) => {
          sent.push(content);
        },
      },
      undefined,
      { write: (message) => logs.push(message) },
    );

    await reporter.report({
      severity: 'error',
      component: 'judge',
      code: 'processing_failed',
      summary: '작업 처리에 실패했습니다.',
      correlationId: 'session:s-1',
      occurredAt: '2026-08-24T12:00:00.000Z',
    });

    expect(sent).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? '')).toMatchObject({
      event: 'operational_diagnostic',
      code: 'processing_failed',
      correlationId: 'session:s-1',
    });
  });

  it('sends a safe formatted alert to the configured channel', async () => {
    const sent: { channelId: string; content: string }[] = [];
    const logs: string[] = [];
    const reporter = new DiscordDiagnosticReporter(
      {
        sendMessage: async (input) => {
          sent.push(input);
        },
      },
      '123456789012345678',
      { write: (message) => logs.push(message) },
    );

    await reporter.report({
      severity: 'error',
      component: 'judge',
      code: 'processing_failed',
      summary: '작업 처리에 실패했습니다.',
      correlationId: 'session:s-1',
      occurredAt: '2026-08-24T12:00:00.000Z',
    });

    expect(sent).toEqual([
      expect.objectContaining({
        channelId: '123456789012345678',
        content: expect.stringContaining('judge'),
      }),
    ]);
    expect(logs.join('\n')).not.toContain('token');
  });
});
