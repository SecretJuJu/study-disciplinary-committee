import { describe, expect, it } from 'vitest';

import { DiscordDiagnosticReporter } from '../src/diagnostics.js';

describe('DiscordDiagnosticReporter', () => {
  it('does not send when a debug channel is not configured', async () => {
    const sent: string[] = [];
    const reporter = new DiscordDiagnosticReporter(
      {
        sendMessage: async ({ content }) => {
          sent.push(content);
        },
      },
      undefined,
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
  });

  it('sends a safe formatted alert to the configured channel', async () => {
    const sent: { channelId: string; content: string }[] = [];
    const reporter = new DiscordDiagnosticReporter(
      {
        sendMessage: async (input) => {
          sent.push(input);
        },
      },
      '123456789012345678',
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
  });
});
