import { describe, expect, it } from 'vitest';
import { buildJudgeInput, estimateLunaCost, judgeRequest, parseJudgment } from '../src/index.js';

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
});
