import { describe, expect, it } from 'vitest';

import { diagnosticForFailure, formatDiagnosticForDiscord } from '../src/index.js';

describe('diagnostics', () => {
  it('formats a safe operational alert without the original error text', () => {
    const event = diagnosticForFailure({
      component: 'judge',
      correlationId: 'session:s-1',
      error: new Error('OPENAI_API_KEY=do-not-send'),
      occurredAt: '2026-08-24T12:00:00.000Z',
    });

    const message = formatDiagnosticForDiscord(event);
    expect(message).toContain('컴포넌트: judge');
    expect(message).toContain('상관 ID: session:s-1');
    expect(message).not.toContain('OPENAI_API_KEY');
  });

  it('classifies a safe external-service cause from an HTTP status', () => {
    const event = diagnosticForFailure({
      component: 'judge',
      correlationId: 'session:s-1',
      error: { status: 503, body: 'sensitive upstream payload' },
      occurredAt: '2026-08-24T12:00:00.000Z',
    });

    expect(event).toMatchObject({
      code: 'external_service_unavailable',
      summary: '외부 서비스가 일시적으로 응답하지 않습니다.',
    });
  });
});
