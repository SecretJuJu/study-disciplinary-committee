---
original_request: '컨텍스트와 기억 최적화를 포함한 serverless Discord 징계위원회 기술 사양을 작성하고, Node.js 24·TypeScript·pnpm·Pulumi·GitHub Actions·AWS Lambda·OpenAI Luna high 기준의 Discord 설정 및 배포 계획을 docs에 기록한다. 월 예산은 $3 전후를 목표로 한다.'
goals:
  - 최소 컨텍스트 AI 판정 구조와 개인정보·비용 제어를 구현한다.
  - Discord HTTP Interactions 기반 MVP를 신뢰성 있게 배포한다.
  - Pulumi와 GitHub Actions OIDC로 재현 가능한 CI/CD를 만든다.
execution_started: true
current_task: null
created_at: 2026-08-24T11:02:34Z
updated_at: 2026-08-24T12:16:00Z
---

# Work Plan: 징계위원회 MVP

> 이 문서는 초기 구현 이력이다. 2026-08-25 production 활성 범위와 운영 계약은 [기술 사양](technical-spec.md)과 [Discord 런북](discord-setup-and-deployment.md)을 따른다. 소스에 존재하는 Scheduler/outbox worker는 현재 Pulumi trigger에 연결되지 않았으며, 등록 명령은 `/help`, `/설정`, `/심사`, `/내기록` 네 개다.

## Goal

월 $3 전후에서 운영 가능한 Discord 학습 심사 봇 MVP를 구현·검증·배포한다.

## Context

- Key files: `docs/technical-spec.md`, `docs/discord-setup-and-deployment.md`
- Existing patterns: 빈 저장소; 구현 패턴은 기술 사양을 기준으로 새로 수립한다.
- Constraints: Node.js 24, TypeScript, pnpm, AWS Lambda, Pulumi, GitHub Actions, `gpt-5.6-luna` + `high`, 대화 전체를 AI에 전달하지 않음.

## Tasks

- [x] 1. pnpm workspace, Node.js 24, TypeScript/ESM, lint·test·format 기준을 초기화한다. -> `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `packages/config/`
- [x] 2. 도메인 상태 전이·점수 정책·Zod 계약을 구현하고 단위 테스트를 작성한다. -> `packages/domain/`
- [x] 3. DynamoDB repository와 조건부/트랜잭션 쓰기, TTL·멱등성 처리를 구현한다. -> `packages/persistence/`
- [x] 4. Discord 서명 검증, command/modal/button parsing, 응답 adapter를 구현하고 위조 요청 테스트를 작성한다. -> `packages/discord/`, `apps/bot-api/`
- [x] 5. 최소 컨텍스트 builder, 고정 prompt, Structured Output parser, OpenAI usage 측정을 구현하고 fixture 평가를 작성한다. -> `packages/ai-judge/`
- [x] 6. interaction Lambda와 judge/outbox Lambda를 구현해 즉시 Discord 응답과 큐 처리를 연결한다. -> `apps/bot-api/`
- [x] 7. Scheduler 기반 소환·마감·주간 결산 worker와 중복 전달 테스트를 구현한다. -> `apps/bot-api/`
- [x] 8. Pulumi dev/prod stack, 최소 IAM, secret references, API/SQS/DynamoDB/Scheduler/알람/Budget를 구현한다. -> `infra/`
- [x] 9. Discord command manifest와 test-guild/global 등록 도구를 구현한다. -> `packages/discord/`, `scripts/`
- [x] 10. GitHub Actions CI와 OIDC 기반 PR preview를 구성하고, 배포 workflow는 제외한다. -> `.github/workflows/`
- [!] 11. Discord Portal·AWS·Pulumi·GitHub bootstrap을 dev에서 수행하고 endpoint/command smoke test를 기록한다. -> `docs/discord-setup-and-deployment.md` (외부 설정은 사용자 지시로 보류)
- [!] 12. 예산·장애·DLQ·역할 계층·데이터 삭제 시나리오를 수동 QA하고 운영 문서를 갱신한다. -> `docs/` (외부 환경 설정 이후 수행)

## Verification

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`
- [ ] Discord PING, 유효/무효 Ed25519 signature, 3초 defer 응답을 통합 테스트한다.
- [ ] 동일 session의 제출/마감/judge 중복 이벤트가 점수·통계를 한 번만 바꾸는지 검증한다.
- [ ] `pulumi preview`가 의도한 리소스만 변경하고 secret output을 노출하지 않는지 확인한다.
- [ ] dev test guild에서 소환 → 제출 → 판결 → 기록 → 불출석 → 주간 결산을 확인한다.
- [ ] AI fixture 50건에서 `high`와 `medium`의 품질/비용/지연을 비교하고 결과를 기록한다.
- [ ] AWS Budget $3 알람과 OpenAI 비용 제한 설정을 확인한다.

## Open Questions

- [ ] Discord 개발자 계정과 AWS 계정의 기존 Free Tier/예산 알림 자격은 무엇인가?
- [x] Pulumi state backend는 versioned private S3와 passphrase 암호화를 사용한다.
- [ ] production Discord guild와 관리자 역할 ID는 무엇인가?
- [ ] raw submission의 90일 보관 및 `/기록삭제` 범위가 운영 정책에 맞는가?
- [ ] OpenAI 프로젝트의 hard spend limit 기능을 사용할 수 있는가?

## Execution Notes

- 2026-08-24: 제품 요구사항 PDF를 분석했다. MVP에서 재심·추가 질문·외부 증거 연동·실제 채널 제재는 제외한다.
- 2026-08-24: AI 기억은 `previous_response_id`를 통한 누적 대화가 아니라, DynamoDB의 최소 사실을 회차별로 조립하는 방식으로 결정했다.
- 2026-08-24: AWS Scheduler/Lambda의 무료 구간은 소규모 베타에 충분하지만, Secrets Manager·CloudWatch는 Free Tier 조건에 따라 $3 목표를 넘길 수 있어 Budget alarm을 필수로 둔다. 베타는 AI 심사를 월 900회로 제한한다.
- 2026-08-24: 작업 1 완료. Node.js 24.16.0, pnpm 10.14.0, TypeScript 5.9.3, ESLint, Prettier, Vitest를 구성했고 `pnpm check`를 통과했다. TypeScript 최신 7.0.2는 `typescript-eslint` 8.67.0의 지원 범위를 벗어나므로 사용하지 않았다.
- 2026-08-24: 작업 2 완료. 도메인 상태 전이, 점수·생존 통계, 엄격한 Zod 입력 계약과 테스트 6개를 추가했고 `pnpm check`를 통과했다.
- 2026-08-24: 작업 3 완료. DynamoDB 단일 테이블 키와 제출·판결·통계 조건부 트랜잭션을 구현하고 중복 판결 차단 조건을 테스트했다. `pnpm check`를 통과했다.
- 2026-08-24: 작업 4 완료. Discord Ed25519 원문 서명 검증, 5분 timestamp 재전송 차단, 관리자 권한 fail-closed 처리, Lambda PING/deferred 응답과 테스트를 추가했다. `pnpm check`를 통과했다.
- 2026-08-24: 작업 5 완료. `gpt-5.6-luna` high 요청의 최소 컨텍스트 builder, `store: false`/`current_turn`, JSON Schema 출력 계약, 사용량 비용 추정과 테스트를 추가했다. API 호출과 키 설정은 수행하지 않았고 `pnpm check`를 통과했다.
- 2026-08-24: 작업 6 완료. Judge worker가 판결·통계를 먼저 확정한 다음 Discord 원본 응답을 갱신하고, outbox worker는 채널 메시지를 검증 후 전송하도록 구현했다. `pnpm check`와 테스트 14개를 통과했다.
- 2026-08-24: 작업 7 완료. Scheduler 작업의 configVersion 검증, 소환 멱등성, 마감·주간 결산 outbox 연결과 테스트를 추가했다. `pnpm check`와 테스트 15개를 통과했다.
- 2026-08-24: 작업 8 완료. Pulumi TypeScript로 DynamoDB, SQS/DLQ, Scheduler group, 최소 IAM, API Gateway, Node.js 24 Lambda, Secret, DLQ 알람과 월 $3 Budget 선언을 추가했다. preview·배포·AWS 호출은 하지 않았고 `pnpm check`를 통과했다.
- 2026-08-24: 작업 9 완료. Guild 전용 명령 manifest와 명시적 scope/환경변수를 요구하는 수동 Discord 명령 등록 스크립트를 추가했다. Discord API 호출은 하지 않았고 `pnpm check`와 테스트 16개를 통과했다.
- 2026-08-24: 작업 10 완료. CI와 OIDC 기반 Pulumi preview workflow 코드를 추가했다. `pulumi up`이나 Discord 명령 등록을 수행하는 배포 workflow는 포함하지 않았고, workflow YAML 파싱 및 `pnpm check`를 통과했다.
- 2026-08-24: 구현 감사에서 Lambda 아티팩트 생성과 실제 외부 호출 어댑터가 빠진 것을 확인했다. esbuild 기반 Node.js 24 번들링과 OpenAI Responses·Discord REST 어댑터를 추가했고, CI도 `pnpm build`를 검증한다. 로컬 빌드만 수행했으며 외부 API·AWS 호출은 하지 않았다.
- 2026-08-24: Discord REST adapter의 성공·실패 처리와 credential이 URL에 노출되지 않는지를 테스트로 검증했다. `pnpm build && pnpm check`를 통과했고 테스트는 18개다.
- 2026-08-24: 코드·스크립트 범위 최종 검증 완료. 외부 GitHub/AWS/Discord 설정 및 환경 QA는 사용자 지시에 따라 보류하며, 배포 workflow와 `pulumi up` 실행은 포함하지 않는다.
- 2026-08-24: Discord 운영 디버깅 요구를 추가했다. `/help`, 관리자 전용 `/운영상태`·`/최근오류` manifest와 안전 진단 이벤트 기반 코드를 추가했다. 알림에는 민감 데이터·원시 오류를 넣지 않으며, 실제 Discord 채널 생성·명령 등록·배포는 수행하지 않는다.
- 2026-08-24: 관리자 AWS CLI profile로 한 번 실행하는 bootstrap, `master` 전용 GitHub OIDC deploy role, private S3 Pulumi backend, GitHub Actions 변수·시크릿 설정, 자동 Pulumi/Discord 배포 workflow를 추가했다. 스크립트와 workflow는 작성·로컬 검증만 하며 AWS/GitHub/Discord 외부 변경은 실행하지 않았다.
- 2026-08-25: AWS/GitHub bootstrap과 production 배포를 실행했다. GitHub OIDC의 불변 owner/repository ID subject, API Gateway 태그, Pulumi Lambda 상태 조회 권한을 최소 범위로 보완했고 Node.js 24 Lambda를 CommonJS로 번들링했다. Actions run `32743671582`에서 Pulumi 배포와 Discord endpoint·guild command 동기화가 성공했다.
- 2026-08-25: `/심사`를 옵션 입력에서 public thread·소유자 버튼 흐름으로 바꿨다. 현재 thread snapshot만 최대 100개·6,000자로 제한하고 기존 SQS/Judge Lambda를 재사용한다. 외부 Discord 등록과 production 배포는 별도 배포 단계에서 검증한다.
- 2026-08-25: 판결 anchor에 최대 2회의 항소 흐름을 추가했다. 항소는 직전 판결 뒤 본인 반박과 익명화한 참여자 참고 진술만 재심하고, 현재 verdict·판정별 통계·징계 점수를 transaction으로 교정하면서 이전 판정은 회차 TTL의 감사 record로 보존한다. production 배포와 실제 과금 항소 QA는 별도 승인 단계다.
- 2026-08-26: 최초 심사 snapshot을 20,000자로 확장하고 초과 입력의 앞뒤 문맥을 보존한다. 항소는 최초 제출 10,000자와 새 반박·참고 진술 8,000자까지 사용하며 AI 호출 횟수와 stateless Responses 구조는 유지한다. production 배포와 실제 과금 장문 QA는 별도 승인 단계다.
- 2026-09-01: 초기 심사 기준은 유지하고 항소 재심 기준만 조정한다. 본인 말로 설명한 이해·구체적 작업 과정·시행착오와 독립적으로 일치하는 참여자 진술을 실질적인 보완 자료로 평가하되, 막연한 보증·다수 의견·학습 시간은 계속 배제한다. 더 불리한 변경은 Structured Output에 명백한 모순 또는 조작 사유가 있을 때만 경계 검증을 통과한다. production 배포와 실제 과금 항소 QA는 별도 승인 단계다.

## Completion Checklist

- [x] Scoped code and script tasks complete
- [x] Local verification passes
- [x] No scope creep
- [x] External setup and environment QA separated
