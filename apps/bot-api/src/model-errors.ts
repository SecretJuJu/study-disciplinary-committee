export const creditExhaustedMessage =
  'AI 심사 크레딧이 소진되어 처리하지 못했습니다. 관리자가 크레딧을 충전한 뒤 `/심사`를 다시 실행해주세요.';

export class NonRetryableModelError extends Error {
  public readonly diagnosticCode = 'ai_credit_exhausted';

  public constructor(options?: ErrorOptions) {
    super('OpenAI API credit balance is exhausted.', options);
    this.name = 'NonRetryableModelError';
  }
}

export type RetryableModelFailureCode =
  'ai_output_incomplete' | 'ai_output_invalid' | 'ai_request_failed';

export class RetryableModelError extends Error {
  public constructor(
    public readonly diagnosticCode: RetryableModelFailureCode,
    options?: ErrorOptions,
  ) {
    super('Retryable model processing failure.', options);
    this.name = 'RetryableModelError';
  }
}

export type RetryableJudgeFailureCode =
  'judgment_lookup_failed' | 'stats_read_failed' | 'judgment_persist_failed';

export class RetryableJudgeError extends Error {
  public constructor(
    public readonly diagnosticCode: RetryableJudgeFailureCode,
    options?: ErrorOptions,
  ) {
    super('Retryable judge processing failure.', options);
    this.name = 'RetryableJudgeError';
  }
}
