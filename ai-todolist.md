---
original_request: '명령 사용법을 help에 포함하고 설정을 실제 저장하며, 코드로 처리할 명령과 AI 심사를 분리해 배포까지 완료한다.'
goals:
  - Discord에서 실제 동작하는 최소 명령만 노출한다.
  - help/settings/stats는 코드와 DynamoDB로 즉시 처리한다.
  - 심사만 SQS와 OpenAI worker로 비동기 처리한다.
  - master GitHub Actions 배포와 Discord smoke check를 통과한다.
execution_started: true
current_task: null
created_at: 2026-08-25T00:25:00+09:00
---

# Work Plan: Discord 명령·설정·AI 심사 완성 배포

## Context

- **Key files**: `packages/discord/`, `packages/persistence/`, `apps/bot-api/`, `infra/index.ts`
- **Patterns**: Zod 경계 검증, DynamoDB 조건부 쓰기, Discord signature와 관리자 권한 fail-closed
- **Scope**: `/help`, `/설정`, `/심사`, `/내기록`만 활성화한다. 정기 Scheduler와 역할 자동 변경은 저장만 하고 활성화하지 않는다.

## Tasks

### Task 1: Discord 명령 계약과 코드 기반 help

**Status:** completed

#### Subtasks

- [x] **1.1** 활성 명령과 subcommand/options를 타입 안전하게 선언한다. → `packages/discord/src/commands.ts`
- [x] **1.2** manifest에서 사용법을 생성하고 interaction options를 엄격히 파싱한다. → `packages/discord/src/`
- [x] **1.3** 명령·help·입력 경계 테스트를 추가한다. → `packages/discord/test/`

#### Acceptance Criteria

- [x] help가 실제 등록 manifest와 자동 일치한다.
- [x] 관리자 명령과 사용자 입력 옵션이 Discord API 계약에 맞는다.
- [x] `pnpm --filter @disciplinary-committee/discord test` 또는 전체 테스트가 통과한다.

### Task 2: GuildSettings·통계·심사 저장소

**Status:** completed

#### Subtasks

- [x] **2.1** `PK=GUILD#{guildId}, SK=SETTINGS` 설정 저장·조회와 configVersion 조건을 구현한다.
- [x] **2.2** 사용자 통계 조회와 최초 심사도 안전한 조건부 판결 저장을 구현한다.
- [x] **2.3** 설정과 심사 저장 경계 테스트를 추가한다.

#### Acceptance Criteria

- [x] 설정은 `guildSettingsSchema` 검증 후 저장되고 stale version은 거부된다.
- [x] 최초 사용자 통계와 중복 판결이 각각 성공/차단된다.
- [x] persistence 테스트가 통과한다.

### Task 3: Interaction router와 AI 전용 queue

**Status:** completed

#### Subtasks

- [x] **3.1** `/help`, `/설정`, `/내기록`을 즉시 ephemeral 응답으로 처리한다.
- [x] **3.2** `/설정 저장`의 Manage Guild 권한을 런타임에서 fail-closed 검증한다.
- [x] **3.3** `/심사`만 제출 저장 후 judge queue에 넣고 deferred 응답한다.
- [x] **3.4** 성공·권한 실패·입력 오류·queue 실패 테스트를 추가한다.

#### Acceptance Criteria

- [x] 어떤 활성 명령도 무기한 “생각 중”으로 남지 않는다.
- [x] OpenAI는 interaction Lambda에서 호출되지 않는다.
- [x] signed interaction 테스트가 통과한다.

### Task 4: Judge Lambda와 Pulumi 연결

**Status:** completed

#### Subtasks

- [x] **4.1** Secrets Manager/DynamoDB/Discord/OpenAI를 조립하는 SQS Lambda handler를 구현한다.
- [x] **4.2** judge Lambda, SQS event source, 함수별 최소 IAM과 환경변수를 Pulumi에 추가한다.
- [x] **4.3** handler batch 실패와 infrastructure typecheck를 검증한다.

#### Acceptance Criteria

- [x] judge queue가 배포된 judge Lambda를 호출한다.
- [x] interaction 역할은 enqueue만, judge 역할은 consume/secret/table만 허용한다.
- [x] `pnpm build && pnpm check`가 통과한다.

### Task 5: 문서·커밋·배포·운영 검증

**Status:** completed

#### Subtasks

- [x] **5.1** help 사용법, 설정 저장 구조, 활성 범위와 AI 경계를 `docs/`에 기록한다.
- [x] **5.2** 자격증명 누출 검사 후 지정 계정으로 commit/push한다.
- [x] **5.3** CI/Deploy 성공, Discord command 동기화, Lambda/SQS/DynamoDB 상태를 확인한다.

#### Acceptance Criteria

- [x] 문서가 배포된 실제 동작과 일치한다.
- [x] GitHub CI와 Deploy가 성공한다.
- [x] Discord endpoint와 명령, AWS runtime이 정상이며 worktree가 clean이다.

## Final Checklist

- [x] All tasks completed
- [x] `pnpm build && pnpm check` passes
- [x] No credential literals committed
- [x] Production deployment verified
- [x] No scope creep

## Execution Notes

- 2026-08-25 01:25 KST: 최초 Deploy `32750246655`는 event-source-mapping ARN이 deploy role IAM 리소스 범위에 없어 실패했다. live policy와 bootstrap에 해당 ARN만 최소 추가한 `cbdf90d` 이후 CI `32750583264`와 Deploy `32750583286`이 성공했다. AWS에서 Node 24 interactions/judge, Enabled judge event source, 빈 SQS/DLQ, ACTIVE DynamoDB와 월 $3 Budget을 확인했고, Discord에서 endpoint·guild command 4개·필수 채널 권한·테스트 메시지와 unsigned 요청 401을 확인했다.
- 2026-08-25 01:19 KST: Task 5 로컬 단계에서 production 활성 명령·설정·deferred/follow-up·환경변수/IAM·안전 진단·미활성 Scheduler 범위를 docs와 일치시켰다. 자격증명 패턴 및 `.env` 추적 검사는 0건이었고 `pnpm build && pnpm check`에서 15개 파일 66개 테스트가 통과했다. 외부 CI/Deploy와 AWS/Discord 상태는 commit/push 후 최종 보고에서만 증거를 남긴다.
- 2026-08-25 01:13 KST: Task 4 완료. strict Zod/Secrets Manager cache/partial batch response를 가진 Judge SQS Lambda를 추가하고, interaction·Judge 역할을 분리해 Node 24 Lambda와 event source를 Pulumi에 연결했다. 기존 verdict 조회와 최신 stats 재조회로 Discord 후속응답 실패 및 동시 심사 재시도를 안전하게 했고 `pnpm build && pnpm check`에서 15개 파일 66개 테스트가 통과했다.
- 2026-08-25 01:03 KST: Task 3 완료. `/help`, `/설정`, `/내기록`은 type 4 ephemeral로 즉시 처리하고 `/심사`만 DynamoDB 저장과 SQS enqueue가 모두 성공한 뒤 type 5를 반환한다. interaction 번들에 OpenAI client/model 문자열이 없음을 확인했고 `pnpm build && pnpm check`에서 14개 파일 58개 테스트가 통과했다.
- queue 전송이 제출 transaction 뒤 실패하면 90일 TTL의 미처리 회차가 남을 수 있다. 사용자 재시도는 새 interaction ID로 별도 회차를 만들며, 원시 오류나 interaction token은 응답·로그에 노출하지 않는다.
