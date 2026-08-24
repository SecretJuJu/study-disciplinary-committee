# Project Guidance

## Scope and safety

- 배포, `pulumi up`, AWS 리소스 생성·삭제, Discord 명령 등록, GitHub 외부 설정은 사용자가 명시적으로 요청할 때만 수행한다.
- 환경 변수, API 키, bot token, Pulumi access token을 파일·로그·테스트 fixture에 기록하지 않는다.
- AWS와 Discord 외부 호출은 어댑터로 분리하고, 단위 테스트에서는 mock으로 검증한다.

## TypeScript and packages

- Node.js 24, pnpm workspace, ESM을 사용한다.
- 새 TypeScript 코드는 strict typing을 유지한다. `any`, non-null assertion, 무검증 `unknown` 변환을 사용하지 않는다.
- 외부 입력(Discord payload, SQS job, OpenAI output, 환경 설정)은 Zod 등으로 경계에서 검증한다.
- 패키지 간 import는 공개 `src/index.ts` export를 사용한다.
- Promise는 항상 `await`하거나 의도적인 fire-and-forget 이유를 문서화한다.

## Domain and reliability

- 판결·점수·통계 갱신은 조건부/트랜잭션 쓰기로 한 번만 반영한다.
- Scheduler, SQS, Discord interaction은 중복 전달될 수 있다고 가정한다.
- AI 요청에는 현재 심사에 필요한 최소 컨텍스트만 넣는다. 이전 제출 원문이나 응답 ID를 누적 전달하지 않는다.
- AI 결과는 Structured Output/Zod 검증 뒤에만 사용한다.

## Verification

- 코드 변경 뒤 `pnpm build && pnpm check`를 실행한다.
- 새 동작에는 성공·실패·경계 조건 테스트를 추가한다.
- 문서·계획 변경은 `docs/`에 기록한다. 외부 환경을 필요로 하는 검증은 수행하지 않았다고 명시한다.
