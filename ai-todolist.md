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

### Task 6: OpenAI 크레딧 소진 오류 처리

**Status:** completed

#### Subtasks

- [x] **6.1** OpenAI `credit_balance_exhausted`를 비재시도 오류로 안전하게 분류한다.
- [x] **6.2** Discord 원본 응답의 무기한 deferred 상태를 명확한 안내로 종료한다.
- [x] **6.3** debug 진단 코드·테스트·운영 문서를 보정하고 production에 배포한다.

#### Acceptance Criteria

- [x] 크레딧 소진 시 `ai_credit_exhausted` 운영 알림이 기록된다.
- [x] 사용자의 `/심사` 응답은 “생각 중”에 남지 않고 충전 후 재시도 안내로 바뀐다.
- [x] 해당 SQS 메시지는 불필요하게 재시도하거나 DLQ로 이동하지 않는다.
- [x] `pnpm build && pnpm check`, CI와 Deploy가 성공한다.

### Task 7: 스레드 기반 심사 UI 구현

**Status:** completed

#### Subtasks

- [x] **7.1** 옵션 없는 `/심사`와 스레드·버튼 사용법을 manifest, parser, `/help`에 반영한다.
- [x] **7.2** draft 심사 회차의 조건부 저장·claim·reopen·완료 상태 전이를 구현한다.
- [x] **7.3** prepare/button/judge-thread 작업과 Discord REST 어댑터를 기존 SQS Judge Lambda에 연결한다.
- [x] **7.4** 스레드 메시지 필터·6,000자 snapshot·중복 방지·안전 실패 처리를 구현한다.
- [x] **7.5** 최소 Discord 권한·Message Content Intent·새 사용 흐름을 검사 스크립트와 운영 문서에 반영한다.
- [x] **7.6** 성공·실패·경계 테스트와 전체 build/check를 통과시킨다.

#### Acceptance Criteria

- [x] `/심사`는 설정된 제출 채널에서 공개 안내와 public thread를 준비하고, 소유자만 `⚖️ 심사 요청` 버튼으로 심사를 시작할 수 있다.
- [x] 심사는 최대 5페이지·500개까지만 조회하고, 그중 소유자의 최신 일반 텍스트 최대 100개를 오래된 순으로 정렬해 6,000자까지 현재 snapshot에 포함한다.
- [x] 빈 제출은 AI 없이 draft를 다시 열고, 중복 전달은 AI·통계 반영을 중복 실행하지 않는다.
- [x] 접수 뒤 guild 설정이 바뀐 회차는 `cancelled`로 닫고, 재전달 시 같은 취소 안내를 deterministic하게 stable anchor에 복구한다.
- [x] public thread 생성의 HTTP 403은 비재시도 권한 안내로 종료하고, HTTP 400/404는 생성 경쟁 여부를 다시 확인한 뒤 재시도한다.
- [x] 판결과 안전 실패 안내는 만료 가능한 interaction webhook이 아닌 고정 anchor 메시지를 bot REST로 갱신한다.
- [x] interaction Lambda는 secret-free를 유지하고, 기존 SQS/Judge Lambda만 사용하며 필요한 IAM만 최소 추가한다.
- [x] 관련 코드·스크립트·문서·테스트가 새 흐름과 일치하고 `pnpm build && pnpm check`가 통과한다.

## Final Checklist

- [ ] All tasks completed
- [x] `pnpm build && pnpm check` passes
- [x] No credential literals committed
- [ ] Production deployment verified
- [x] No scope creep

## Execution Notes

- 2026-08-25 11:40 KST: 최종 pre-commit review 보정을 기록했다. 접수 뒤 guild 설정이 변경되면 회차를 `cancelled`로 조건부 전이하고, anchor 수정이 일시 실패해 SQS가 재전달되어도 저장 상태에서 동일한 취소 안내를 deterministic하게 복구한다. Discord public thread 생성은 권한 부족 HTTP 403만 비재시도 setup 결과로 바꿔 명시적인 권한 안내를 게시하며, HTTP 400/404는 이미 thread가 만들어진 race인지 GET으로 재확인한 뒤 없으면 원래 오류를 유지해 재시도한다. 보정 관련 narrow 테스트 47개가 통과한 뒤 Root가 `pnpm build && pnpm check`를 재실행해 16개 파일 111개 테스트와 build/format/ESLint/strict typecheck를 모두 통과했다. 추가 안전 검사도 `credential_pattern_hits=0`, `tracked_env_files=0`, `interaction_secret_markers=0`, cached diff check 통과로 확인했다. 이 기록 단계에서는 코드·stage·commit·push·deploy를 수행하지 않았다.
- 2026-08-25 11:14 KST: Task 7 완료. `/심사`를 옵션 없는 공개 접수로 바꾸고 prepare(1초 지연)와 judge-thread discriminated SQS job을 기존 Judge Lambda에 연결했다. signed component는 guild·owner·anchor·thread/channel·configVersion·deadline을 검증하고 `draft → queued`를 조건부 claim한다. worker는 8분 lease로 중복 AI를 억제한다. Discord timestamp는 UTC `Z`와 유효한 offset을 허용한다. thread는 최대 5페이지·500개까지만 bounded pagination으로 조회하고, 버튼 시각 이전 소유자의 최신 type 0 non-bot 텍스트 최대 100개를 오래된 순으로 정렬해 Unicode 6,000자로 snapshot한다. 재시도 release는 `claimedAt`을 보존하고 실제 reopen만 제거해 버튼 시각 경계를 유지한다. 빈 제출/크레딧 소진은 draft와 버튼을 복구하고, 판결·안전 실패는 bot REST로 stable anchor를 수정한다. 판결·통계·session finalized는 단일 transaction이다. Discord 점검에 Read Message History/Create Public Threads/Send Messages in Threads와 Message Content Intent를 추가했고 IAM은 두 함수의 DynamoDB UpdateItem만 확장했다. 현재 production은 debug 채널과 submission 채널이 동일하다는 전제로 권한 smoke check를 수행한다. 최초 검증 16개 파일 103개 테스트 이후 Root review 보정까지 포함한 최종 검증은 16개 파일 111개 테스트와 build/format/ESLint/strict typecheck를 모두 통과했다. credential pattern, tracked env file, interaction secret marker는 각각 0건이고 cached diff check도 통과했다. 외부 Discord command 등록·AWS 배포·production 수동 QA는 이 Task 범위에서 수행하지 않았다.
- 2026-08-25 10:47 KST: Task 6 기존 구현을 재검증했다. `credit_balance_exhausted`는 `NonRetryableModelError`와 `ai_credit_exhausted` 안전 진단으로 변환되고, Judge가 Discord 원본 응답을 충전 후 새 `/심사` 안내로 수정한 뒤 정상 반환하므로 성공 경로에서는 SQS partial batch failure가 생성되지 않는다. 대상 테스트 4개 파일 29개와 `pnpm build && pnpm check`의 전체 15개 파일 81개 테스트가 통과했다. 커밋 `493c116`의 CI `32794297155`와 Deploy `32794297152`가 성공했고, 배포 단계의 check/build/Pulumi/Discord 등록·검증도 모두 성공했다. AWS에서 Judge Lambda Node 24/Active/업데이트 성공, event source Enabled·batch size 1·partial batch response, judge queue 0건을 확인했다. DLQ에는 수정 전 실패로 보이는 기존 3건이 남아 있으며 이번 검증에서는 삭제하거나 본문을 조회하지 않았다.
- 2026-08-25 09:10 KST: session `1541599553558544454` 실패를 안전하게 재현했다. Luna 모델 조회는 HTTP 200이지만 Responses 생성은 HTTP 429, `credit_balance_exhausted`/`insufficient_quota`로 거절되어 요청 형식이 아니라 OpenAI 조직 크레딧 0이 원인이다. 비밀값과 제출 원문은 출력하지 않았다.
- 2026-08-25 09:14 KST: 충전 뒤 session `1541600541266944041`은 제출만 저장되고 판결 전 `processing_failed`가 발생했다. 동일 저장 제출의 Luna/high/Structured Output 재현은 완료·검증 성공했다. high reasoning과 JSON이 공유하는 출력 상한의 간헐적 소진을 줄이도록 700→2,000으로 조정하고 AI 출력·Discord 후속응답 실패 코드를 분리한다.
- 2026-08-25 09:22 KST: 새 코드 재시도도 Lambda timeout/throttle 없이 4.8초 만에 `processing_failed`로 끝났다. 동일 최신 제출의 OpenAI 출력은 별도 재현에서 완료·검증 성공했으므로 조회·OpenAI 요청·저장 단계를 안전 코드로 추가 분리한다. CloudWatch에는 safe structured diagnostic만 남긴다.
- 2026-08-25 09:28 KST: 단계별 진단에서 `judgment_persist_failed`를 확인했다. production Judge 역할은 `TransactWriteItems`만 허용했지만 transaction 내부 Put에는 `dynamodb:PutItem`도 필요했다. 로컬 관리자 자격증명으로 같은 transaction이 성공한 것과 AWS의 transaction IAM 계약을 대조해 원인을 확정했다. 기존 runtime boundary가 이미 허용하는 `PutItem`을 Judge 인라인 정책에 추가하되 `dynamodb:EnclosingOperation = TransactWriteItems` 조건으로 transaction 내부에만 제한한다.

- 2026-08-25 01:25 KST: 최초 Deploy `32750246655`는 event-source-mapping ARN이 deploy role IAM 리소스 범위에 없어 실패했다. live policy와 bootstrap에 해당 ARN만 최소 추가한 `cbdf90d` 이후 CI `32750583264`와 Deploy `32750583286`이 성공했다. AWS에서 Node 24 interactions/judge, Enabled judge event source, 빈 SQS/DLQ, ACTIVE DynamoDB와 월 $3 Budget을 확인했고, Discord에서 endpoint·guild command 4개·필수 채널 권한·테스트 메시지와 unsigned 요청 401을 확인했다.
- 2026-08-25 01:19 KST: Task 5 로컬 단계에서 production 활성 명령·설정·deferred/follow-up·환경변수/IAM·안전 진단·미활성 Scheduler 범위를 docs와 일치시켰다. 자격증명 패턴 및 `.env` 추적 검사는 0건이었고 `pnpm build && pnpm check`에서 15개 파일 66개 테스트가 통과했다. 외부 CI/Deploy와 AWS/Discord 상태는 commit/push 후 최종 보고에서만 증거를 남긴다.
- 2026-08-25 01:13 KST: Task 4 완료. strict Zod/Secrets Manager cache/partial batch response를 가진 Judge SQS Lambda를 추가하고, interaction·Judge 역할을 분리해 Node 24 Lambda와 event source를 Pulumi에 연결했다. 기존 verdict 조회와 최신 stats 재조회로 Discord 후속응답 실패 및 동시 심사 재시도를 안전하게 했고 `pnpm build && pnpm check`에서 15개 파일 66개 테스트가 통과했다.
- 2026-08-25 01:03 KST: Task 3 완료. `/help`, `/설정`, `/내기록`은 type 4 ephemeral로 즉시 처리하고 `/심사`만 DynamoDB 저장과 SQS enqueue가 모두 성공한 뒤 type 5를 반환한다. interaction 번들에 OpenAI client/model 문자열이 없음을 확인했고 `pnpm build && pnpm check`에서 14개 파일 58개 테스트가 통과했다.
- queue 전송이 제출 transaction 뒤 실패하면 90일 TTL의 미처리 회차가 남을 수 있다. 사용자 재시도는 새 interaction ID로 별도 회차를 만들며, 원시 오류나 interaction token은 응답·로그에 노출하지 않는다.
