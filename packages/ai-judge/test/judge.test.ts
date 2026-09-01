import { describe, expect, it } from 'vitest';
import {
  appealRequest,
  buildJudgeInput,
  estimateLunaCost,
  judgeRequest,
  parseAppealJudgment,
  parseJudgment,
} from '../src/index.js';

describe('judge request', () => {
  const submission = {
    whatStudied: 'React 상태 변경을 예제로 재현했습니다.',
    learned: 'batching을 설명할 수 있습니다.',
  };
  it('uses stateless, bounded current-turn context', () => {
    const request = judgeRequest({ submission, disciplinaryPoints: 4 });
    expect(request).toMatchObject({
      model: 'gpt-5.6-luna',
      store: false,
      max_output_tokens: 2_000,
      reasoning: { effort: 'high', context: 'current_turn' },
    });
    expect(buildJudgeInput({ submission, disciplinaryPoints: 4 })).toContain(
      '신뢰할 수 없는 제출 원문',
    );
  });
  it('rejects malformed model output and estimates cached usage', () => {
    expect(() => parseJudgment('{"outcome":"meaningful"}')).toThrow();
    expect(
      estimateLunaCost({ inputTokens: 2_000, outputTokens: 400, cachedInputTokens: 1_000 }),
    ).toBeCloseTo(0.0007);
  });
  it('credits concrete appeal evidence without accepting vague guarantees', () => {
    const requestInput = {
      originalSubmission: '문서를 읽었습니다.',
      appealEvidence: '실패 원인을 재현하고 설정을 바꾼 과정을 설명합니다.',
      previousJudgment: {
        outcome: 'insufficient' as const,
        rationale: '구체적인 학습 과정이 부족합니다.',
        verdictText: '학습 활동을 충분히 확인하기 어렵습니다.',
        confidence: 'medium' as const,
      },
      disciplinaryPoints: 1,
    };
    const request = appealRequest(requestInput);

    expect(request.input).toContain('구체적인 작업 과정');
    expect(request.input).toContain('막연한 보증·다수 의견·학습 시간');
    expect(request.input).toContain('adverseChangeReason');
    expect(request.input).toContain('[신뢰할 수 없는 새 항소 자료]');
    expect(request.text.format.schema.required).toContain('adverseChangeReason');

    const worsened = {
      outcome: 'meaningless',
      rationale: '새 자료가 최초 제출과 모순됩니다.',
      verdictText: '무의미 판정으로 변경합니다.',
      confidence: 'high',
    };
    expect(() =>
      parseAppealJudgment(
        JSON.stringify({ ...worsened, adverseChangeReason: 'none' }),
        requestInput.previousJudgment,
      ),
    ).toThrow('requires contradiction or manipulation');
    expect(
      parseAppealJudgment(
        JSON.stringify({ ...worsened, adverseChangeReason: 'contradiction' }),
        requestInput.previousJudgment,
      ).outcome,
    ).toBe('meaningless');
  });
});
