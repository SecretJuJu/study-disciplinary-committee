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

  it('classifies exhausted AI credit without exposing the upstream message', () => {
    const event = diagnosticForFailure({
      component: 'judge',
      correlationId: 'session:s-1',
      error: {
        diagnosticCode: 'ai_credit_exhausted',
        message: 'sensitive upstream billing detail',
      },
      occurredAt: '2026-08-24T12:00:00.000Z',
    });

    expect(event).toMatchObject({
      code: 'ai_credit_exhausted',
      summary: 'OpenAI API 크레딧이 소진되었습니다.',
    });
    expect(formatDiagnosticForDiscord(event)).not.toContain('sensitive upstream billing detail');
  });

  it.each([
    ['ai_output_incomplete', 'AI 응답이 출력 한도 안에서 완료되지 않았습니다.'],
    ['ai_output_invalid', 'AI 응답이 판결 형식 검증을 통과하지 못했습니다.'],
    ['discord_request_rejected', 'Discord API가 후속 응답 요청을 거절했습니다.'],
  ])('formats the safe diagnostic code %s', (diagnosticCode, summary) => {
    const event = diagnosticForFailure({
      component: 'judge',
      correlationId: 'session:s-1',
      error: { diagnosticCode },
      occurredAt: '2026-08-24T12:00:00.000Z',
    });

    expect(event).toMatchObject({ code: diagnosticCode, summary });
  });
});
