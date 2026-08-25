import { z } from 'zod';

const diagnosticComponentSchema = z.enum(['interactions', 'judge', 'scheduler', 'outbox']);
export type DiagnosticComponent = z.infer<typeof diagnosticComponentSchema>;

export const diagnosticEventSchema = z
  .object({
    severity: z.enum(['warning', 'error']),
    component: diagnosticComponentSchema,
    code: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
    summary: z.string().trim().min(1).max(160),
    correlationId: z.string().trim().min(1).max(128),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  const status = error.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function diagnosticCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('diagnosticCode' in error)) {
    return undefined;
  }
  return typeof error.diagnosticCode === 'string' ? error.diagnosticCode : undefined;
}

function failureDetails(error: unknown): Pick<DiagnosticEvent, 'code' | 'summary'> {
  const diagnosticCode = diagnosticCodeOf(error);
  if (diagnosticCode === 'ai_credit_exhausted') {
    return {
      code: 'ai_credit_exhausted',
      summary: 'OpenAI API 크레딧이 소진되었습니다.',
    };
  }
  if (diagnosticCode === 'ai_output_incomplete') {
    return {
      code: 'ai_output_incomplete',
      summary: 'AI 응답이 출력 한도 안에서 완료되지 않았습니다.',
    };
  }
  if (diagnosticCode === 'ai_output_invalid') {
    return {
      code: 'ai_output_invalid',
      summary: 'AI 응답이 판결 형식 검증을 통과하지 못했습니다.',
    };
  }
  if (diagnosticCode === 'discord_service_unavailable') {
    return {
      code: 'discord_service_unavailable',
      summary: 'Discord API가 일시적으로 요청을 처리하지 못했습니다.',
    };
  }
  if (diagnosticCode === 'discord_request_rejected') {
    return {
      code: 'discord_request_rejected',
      summary: 'Discord API가 후속 응답 요청을 거절했습니다.',
    };
  }
  if (error instanceof z.ZodError) {
    return { code: 'invalid_job', summary: '큐 작업의 입력 형식 검증에 실패했습니다.' };
  }
  if (error instanceof Error && error.name === 'TransactionCanceledException') {
    return { code: 'state_conflict', summary: '중복 또는 오래된 상태 변경이 거절되었습니다.' };
  }
  const status = statusCodeOf(error);
  if (status !== undefined && status >= 500) {
    return {
      code: 'external_service_unavailable',
      summary: '외부 서비스가 일시적으로 응답하지 않습니다.',
    };
  }
  if (status !== undefined && status >= 400) {
    return { code: 'external_request_rejected', summary: '외부 서비스가 요청을 거절했습니다.' };
  }
  return { code: 'processing_failed', summary: '작업 처리에 실패했습니다.' };
}

export function diagnosticForFailure(input: {
  component: DiagnosticComponent;
  correlationId: string;
  error: unknown;
  occurredAt?: string;
}): DiagnosticEvent {
  const details = failureDetails(input.error);
  return diagnosticEventSchema.parse({
    severity: 'error',
    component: input.component,
    ...details,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
}

export function formatDiagnosticForDiscord(rawEvent: unknown): string {
  const event = diagnosticEventSchema.parse(rawEvent);
  return [
    `⚠️ 운영 알림 · ${event.severity.toUpperCase()}`,
    `컴포넌트: ${event.component}`,
    `코드: ${event.code}`,
    `내용: ${event.summary}`,
    `상관 ID: ${event.correlationId}`,
    `시각(UTC): ${event.occurredAt}`,
  ].join('\n');
}
