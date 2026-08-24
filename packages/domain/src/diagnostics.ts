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

function failureDetails(error: unknown): Pick<DiagnosticEvent, 'code' | 'summary'> {
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
