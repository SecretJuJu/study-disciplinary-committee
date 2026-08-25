# Execution Started: 2026-08-25T00:25:00+09:00

## Decisions

- 활성 명령은 `/help`, `/설정`, `/심사`, `/내기록`으로 제한한다.
- `/help`, `/설정`, `/내기록`은 AI 없이 즉시 처리한다.
- `/심사`만 deferred + SQS + OpenAI Judge Lambda를 사용한다.
- 정기 Scheduler와 역할 자동 변경은 이번 배포에서 활성화하지 않는다.

## Known gaps before execution

- 기존 interaction Lambda는 모든 명령에 type 5만 반환한다.
- GuildSettings persistence가 없고 production DynamoDB item count는 0이다.
- judge source bundle은 있지만 Lambda handler/event source가 없다.

## Failed approaches

- zsh에서 `path` 변수를 사용해 PATH를 덮어쓴 컨텍스트 읽기 명령은 실패했다. 이후 bash와 `context_file` 변수를 사용한다.

[2026-08-25 00:44] - Discord 명령 계약과 코드 기반 help

### DISCOVERED ISSUES

- 기존 manifest가 동작하지 않는 명령 6개까지 등록하고 `/설정` 입력 계약과 `/심사` 명령을 제공하지 않았다.
- 기존 interaction parser는 `data.options`를 구조화하거나 검증하지 않아 알 수 없는 옵션과 잘못된 타입을 구분할 수 없었다.

### DECISIONS

- 활성 manifest를 `/help`, `/설정`, `/심사`, `/내기록`으로 제한하고 `/설정`만 Manage Guild(`32`) 기본 권한을 유지했다.
- `/설정 저장`은 제출·판결 텍스트 채널을 필수로 받고, `/심사`는 학습내용 필수와 학습시간·배운점 선택 입력을 받도록 Discord API 타입과 경계를 선언했다.
- help는 등록 manifest를 순회해 명령 경로, 필수·선택 옵션, 관리자 여부를 생성하도록 해 별도 명령 목록과의 불일치를 없앴다.
- 외부 option payload는 명령별 Zod allowlist, 엄격한 필드, 중복 방지, 문자열 길이와 숫자 범위로 검증한다.

### FAILED APPROACHES

- 동일 파일을 한 `apply_patch`에서 Delete와 Add로 교체하려던 patch는 도구가 중복 대상을 거부했다. 삭제와 추가를 분리해 적용했다.
- manifest 상수를 지나치게 좁게 추론해 테스트 typecheck가 실패했다. 공개 `readonly ApplicationCommand[]` 타입을 명시해 소비 코드가 선택 속성에 안전하게 접근하도록 수정했다.

### LEARNINGS

- Discord subcommand type은 `1`, string은 `3`, integer는 `4`, channel은 `7`이며 guild text channel 제한은 `channel_types: [0]`이다.
- `pnpm exec vitest run packages/discord/test`는 2개 파일 11개 테스트, 전체 `pnpm build && pnpm check`는 13개 파일 33개 테스트로 통과했다.

### NEXT TASK TIPS

- router는 `parseApplicationCommand`의 discriminated union과 `commandHelp`를 직접 사용하면 명령별 분기와 즉시 help 응답을 별도 재파싱 없이 구현할 수 있다.
- `/설정 저장`의 runtime 관리자 권한 검사는 manifest 기본 권한만 신뢰하지 말고 `hasManageGuildPermission`으로 fail-closed 처리해야 한다.

[2026-08-25 00:46] - Task 1 snowflake 계약 검증 보정

### DISCOVERED ISSUES

- Task 1 최초 구현의 snowflake 정규식이 1자리 테스트 ID를 허용해 저장소의 17~20자리 Discord ID 계약보다 느슨했다.

### DECISIONS

- interaction, application, guild, user, command, channel ID가 공유하는 snowflake schema를 `^\d{17,20}$`로 강화했다.
- 성공 fixture는 모두 실제 Discord 형식의 19자리 ID로 교체하고, 짧은 ID 거부 사례를 명시적으로 검증했다.

### FAILED APPROACHES

- 없음.

### LEARNINGS

- 테스트 편의를 위한 짧은 ID를 경계 schema에서 허용하면 production 계약이 약해진다. fixture가 production 형식을 따라야 한다.
- Discord 패키지 테스트 2개 파일 11개와 전체 TypeScript typecheck가 통과했다.

### NEXT TASK TIPS

- 후속 router 및 persistence 테스트에서도 guild/user/channel fixture는 17~20자리 snowflake를 사용해야 한다.

[2026-08-25 00:52] - GuildSettings·통계·심사 저장소

### DISCOVERED ISSUES

- 기존 통계 판결 transaction은 항상 `totalReviews = 0`을 요구해 아직 UserStats 항목이 없는 최초 사용자 판결을 저장할 수 없었다.
- 전체 `pnpm check` 실행에서 Task 1의 snowflake 경계 강화와 달리 bot-api PING 테스트가 1자리 interaction/application ID를 계속 사용해 1건 실패했다. persistence 범위와 무관하며 Task 3에서 fixture 보정이 필요하다.

### DECISIONS

- GuildSettings는 `PK=GUILD#{guildId}`, `SK=SETTINGS`에 저장하고, 최초 생성은 item 미존재와 `configVersion=1`, 갱신은 저장 버전이 expected version보다 정확히 1 큰 경우와 DynamoDB의 현재 버전 일치를 함께 강제한다.
- DynamoDB 조회 결과는 저장 envelope를 먼저 확인한 뒤 `guildSettingsSchema` 또는 `userStatsSchema`로 파싱한다.
- `/심사`용 회차와 첫 제출은 interaction ID를 sessionId로 사용하고 두 Put 모두 item 미존재 조건을 둔 단일 transaction으로 생성한다.
- 최초 통계 쓰기는 item 미존재만 허용하고, 두 번째 판결부터는 기존 항목 존재와 `totalReviews` 일치를 요구한다. 판결 item의 기존 중복 차단 조건은 유지한다.

### FAILED APPROACHES

- 최초 전체 검증에서 persistence 테스트 파일이 Prettier 형식과 달라 실패했다. 저장소 포맷터로 정리한 뒤 대상 검사 전체를 재실행했다.
- 전체 `pnpm check`는 persistence 외부의 오래된 bot-api fixture 1건 때문에 실패했다. 소유 범위를 넘겨 수정하지 않고 root agent에 전달했다.

### LEARNINGS

- `GetCommand`는 설정·통계 조회에 `ConsistentRead: true`를 사용해야 바로 앞 설정 변경과 심사 enqueue가 오래된 값을 읽을 가능성을 줄일 수 있다.
- persistence 단위 테스트 14개, package typecheck, Prettier, ESLint, diff check가 모두 통과했다.

### NEXT TASK TIPS

- router는 `getGuildSettings`, `saveGuildSettings`, `getUserStats`, `createAdHocReview` 공개 메서드를 사용하면 된다.
- 설정 갱신은 조회한 `configVersion`을 `expectedConfigVersion`으로 넘기고 새 설정에는 `configVersion + 1`을 넣어야 한다. 조건 실패는 동시 변경 안내로 변환한다.
- 신규 사용자의 `/내기록`은 `getUserStats`의 `undefined`를 0회 통계 화면으로 처리한다.

[2026-08-25 01:03] - Interaction router와 AI 전용 queue

### DISCOVERED ISSUES

- 기존 interaction Lambda가 서명 검증 뒤 모든 command/component/modal에 type 5만 반환해 `/help`와 `/설정`도 후속 응답 없이 무기한 대기했다.
- bot-api PING fixture는 강화된 Discord snowflake 계약과 달리 1자리 ID를 사용하고 있었다.
- bot-api가 DynamoDB와 SQS runtime client를 직접 사용하려면 해당 AWS SDK 패키지를 direct dependency로 선언해야 했다.

### DECISIONS

- `/help`는 manifest 기반 문자열만, `/설정`과 `/내기록`은 DynamoDB만 사용해 type 4 ephemeral로 즉시 응답한다. `/설정 보기`와 `저장` 모두 Manage Guild를 런타임에서 fail-closed 검사한다.
- 최초 설정은 활성 상태, `Asia/Seoul`, 1일 cadence, 60분 제출 창, 역할 자동 변경 비활성 기본값으로 만들고, 갱신은 기존 정책을 보존하면서 채널과 configVersion만 변경한다.
- `/심사`는 현재 제출과 짧은 통계만 JudgeJob에 넣고, 회차·제출 transaction과 SQS enqueue가 모두 성공한 경우에만 type 5를 반환한다. interaction handler는 OpenAI 모듈을 runtime import하지 않는다.
- repository, judge queue, clock을 주입해 signed interaction 단위 테스트가 AWS를 호출하지 않도록 했다.

### FAILED APPROACHES

- `pnpm install --offline`은 새 `@aws-sdk/client-sqs` tarball이 로컬 store에 없어 실패했다. 일반 `pnpm install`로 lockfile과 workspace link를 정상 구성했다.
- 동일 테스트 파일을 한 patch에서 Delete와 Add로 교체하려던 시도는 patch 도구가 중복 대상을 거부했다. 삭제와 추가를 별도 patch로 적용했다.
- 최초 SQS adapter 테스트 mock은 인자 없는 함수로 추론되어 TypeScript에서 call tuple이 빈 배열이 됐다. `vi.fn<SqsMessageSender['send']>`로 외부 경계의 정확한 함수 타입을 지정했다.

### LEARNINGS

- Discord 관리 권한 값은 payload의 문자열 bitset에서 `32` 비트를 확인해야 하며 manifest 기본 권한만으로는 runtime authorization을 대체할 수 없다.
- SQS 메시지에는 interaction token이 포함되므로 원시 job·exception을 로그나 Discord 오류 응답에 출력하면 안 된다.
- bot-api 대상 테스트 7개 파일 21개, 전체 `pnpm check` 14개 파일 58개 테스트, build, lint, typecheck, format, diff check가 통과했다. interaction 번들에는 OpenAI client/model marker가 없다.

### NEXT TASK TIPS

- Pulumi interaction Lambda에 `JUDGE_QUEUE_URL`을 주입하고 해당 함수 역할에는 judge queue `sqs:SendMessage`만 허용해야 한다.
- Judge Lambda는 이 메시지의 `guildId`, `sessionId`, `userId`, `submission`, `stats`, `scorePolicy`, `interactionToken`, `applicationId` 계약을 Zod로 다시 검증해 처리해야 한다.
- DynamoDB 저장 뒤 SQS 전송이 실패하면 TTL까지 미처리 회차가 남는다. 응답은 즉시 오류로 끝나며 사용자의 재시도는 새 interaction ID를 사용한다.

[2026-08-25 01:13] - Judge Lambda와 Pulumi 연결

### DISCOVERED ISSUES

- 기존 JudgeWorker는 판결 transaction 뒤 Discord 후속응답이 실패하면 재시도 때 동일 판결 transaction부터 충돌해 원래 응답을 다시 보낼 수 없었다.
- interaction이 enqueue 시 넣은 통계 snapshot만 사용하면 같은 사용자의 여러 심사가 동시에 처리될 때 뒤의 판결이 stale stats 조건으로 계속 실패할 수 있었다.
- bot-api에 Secrets Manager client direct dependency와 실제 SQS Lambda handler가 없었고, 기존 단일 Lambda 역할은 interaction에도 secret read와 queue consume을 허용했다.

### DECISIONS

- Judge는 처리 시작 시 기존 verdict를 일관 읽기로 확인하고 있으면 AI·통계 transaction을 건너뛰고 Discord 원본 응답만 수정한다. 판결 저장 뒤 Discord 장애가 발생해도 SQS 재시도로 복구된다.
- 판결 전 현재 UserStats를 일관 읽기로 사용하고, transaction conflict에 현재 session의 verdict가 없으면 최신 통계를 다시 읽어 동일 판결 저장을 한 번 재시도한다.
- Secrets Manager의 strict JSON은 성공한 Promise만 컨테이너에 캐시한다. 실패한 fetch/validation은 캐시를 비워 다음 SQS 재시도에서 다시 읽는다.
- interaction 역할은 DynamoDB Get/Put/Transact와 judge queue SendMessage로 축소하고, 별도 Judge 역할에는 DynamoDB Get/Transact, secret read, judge queue poll/delete/attributes와 로그만 허용했다.
- Judge Lambda timeout은 90초, SQS visibility는 540초로 두고 batch size 1 및 `ReportBatchItemFailures`를 사용한다.

### FAILED APPROACHES

- 첫 dependency 갱신에서 `pnpm install --lockfile-only`만 실행해 새 Secrets Manager client가 node_modules에 없어 테스트 import가 실패했다. 일반 `pnpm install`로 workspace 설치를 동기화했다.
- 설정 파일을 지정하지 않은 Prettier 실행이 기본 double quote로 파일을 바꿨다. 프로젝트의 `packages/config/prettier.config.mjs`를 명시해 즉시 저장소 스타일로 복구했다.

### LEARNINGS

- AWS Lambda의 SQS poller 실행 역할에 필요한 최소 queue action은 `ReceiveMessage`, `DeleteMessage`, `GetQueueAttributes`이며 기존 runtime boundary가 모두 포함하고 있었다.
- `pnpm build && pnpm check`에서 Judge handler bundle smoke load, 15개 테스트 파일 66개 테스트, format/lint/typecheck가 통과했다.
- interaction bundle에는 OpenAI model/client/key marker가 없고 Judge handler bundle에만 Luna model과 `current_turn` 설정이 포함된다.

### NEXT TASK TIPS

- 실제 배포 전에 기존 bootstrap으로 생성된 runtime permissions boundary가 최신 기본 version인지 확인하되, Task 4에 필요한 SQS poll action은 스크립트에 이미 선언되어 있어 bootstrap 수정은 필요 없다.
- 배포 후 Judge event source mapping 상태가 `Enabled`, Judge Lambda runtime이 `nodejs24.x`, timeout이 90초인지 확인한다.
- Discord `/심사` 실사용 검증은 유료 OpenAI 호출을 발생시키며, 성공 후 DynamoDB Verdict/UserStats와 SQS backlog 0을 함께 확인해야 한다.

[2026-08-25 01:19] - Production 운영 문서와 배포 검증

### DISCOVERED ISSUES

- 기존 기술 사양과 Discord 런북은 Scheduler, 역할 자동 변경, 과거 관리자 명령을 현재 활성 production 기능처럼 기술하고 있어 실제 네 command 배포 범위와 달랐다.

### DECISIONS

- 운영 기준은 `/help`, `/설정`, `/심사`, `/내기록` 네 command와 interactions→judge SQS 경로로 고정하고, Scheduler/outbox 리소스는 worker/trigger가 연결되지 않은 미래 범위로 명시한다.
- Lambda 스트리밍 대신 Discord type 5 deferred와 webhook 원본 응답 수정을 사용하며, AI는 `/심사`에만 적용한다고 문서화한다.
- 배포 뒤 생성되는 run ID는 worktree를 다시 더럽히지 않도록 저장소 문서가 아니라 최종 실행 보고에 남긴다.

### FAILED APPROACHES

- 첫 credential scan은 no-match인 `rg`의 종료 코드가 `set -e`를 중단시켜 결과를 출력하지 못했다. no-match를 정상 상태로 처리하는 안전한 count 방식으로 다시 실행했다.

### LEARNINGS

- production runtime은 interactions Node 24/10초와 judge Node 24/90초이며, Judge event source는 batch size 1과 `ReportBatchItemFailures`를 사용한다.
- credential-like 파일과 추적·미추적 `.env`류는 모두 0건이고, 전체 build/check는 15개 파일 66개 테스트로 통과했다.

### NEXT TASK TIPS

- 자동 Discord smoke는 유료 OpenAI 호출을 하지 않는다. `/심사` 최종 판결과 `/내기록` 증가 확인은 사용자가 Discord에서 한 번 실행해야 한다.

[2026-08-25 09:10] - OpenAI 크레딧 소진 운영 처리

### DISCOVERED ISSUES

- production 키와 Luna 모델 접근은 유효하지만 Responses 생성은 `429 credit_balance_exhausted`로 거절됐다.
- 기존 generic 4xx 처리는 debug 원인을 `external_request_rejected`로만 표시하고 Discord 원본 응답을 계속 deferred 상태로 남겼다.

### DECISIONS

- 크레딧 소진만 명시적인 비재시도 모델 오류로 변환한다. 일시적 rate limit과 5xx는 기존 SQS 재시도를 유지한다.
- 비재시도 오류는 safe diagnostic을 보낸 뒤 Discord 원본 응답을 충전 후 새 `/심사` 실행 안내로 수정하고 SQS message를 성공 처리한다.

### LEARNINGS

- 모델 조회 HTTP 200은 생성 크레딧을 보장하지 않는다. 배포 smoke와 별도로 최소 Responses 호출 또는 OpenAI usage/billing 확인이 필요하다.

[2026-08-25 09:28] - DynamoDB transaction IAM

### LEARNINGS

- `dynamodb:TransactWriteItems` 허용만으로 transaction 내부 Put 권한이 충족되지 않는다. Judge 역할에는 transaction API 권한과 함께 내부 작업에 해당하는 `dynamodb:PutItem`이 필요하며, `dynamodb:EnclosingOperation = TransactWriteItems` 조건으로 독립 Put을 차단할 수 있다.
- IAM simulator에서 `TransactWriteItems`만 단독 확인하면 이 누락을 놓칠 수 있다. transaction을 사용하는 역할은 API 작업과 내부 item 작업 권한을 함께 검증한다.

[2026-08-25 10:47] - OpenAI 크레딧 소진 오류 처리 검증

### DISCOVERED ISSUES

- production judge queue는 비어 있지만 DLQ에는 수정 전 실패로 보이는 기존 메시지 3건이 남아 있다. 이번 검증은 파괴적 정리나 메시지 본문 조회를 수행하지 않았다.

### DECISIONS

- `credit_balance_exhausted`를 `NonRetryableModelError`로 변환하고, 안전 진단 게시 후 Discord 원본 응답을 충전·재실행 안내로 수정해 정상 반환하는 현재 경로를 Task 6의 비재시도 기준으로 확정했다.
- 실제 크레딧 오류를 유료 API로 다시 유발하지 않고 경계·worker 단위 테스트, 성공한 배포 SHA, 읽기 전용 AWS 상태로 검증했다.

### FAILED APPROACHES

- 없음.

### LEARNINGS

- worker가 비재시도 오류를 처리하고 정상 반환하면 SQS handler는 해당 record를 `batchItemFailures`에 넣지 않으므로 같은 메시지를 재시도하거나 DLQ로 보내지 않는다.
- 커밋 `493c116`의 CI `32794297155`와 Deploy `32794297152`가 성공했으며, Judge Lambda는 Node.js 24·Active·업데이트 성공, event source는 Enabled·batch size 1·`ReportBatchItemFailures` 상태다.

### NEXT TASK TIPS

- DLQ 기존 3건을 정리하려면 먼저 보존·삭제 정책을 사용자와 합의한다. Task 6 검증 증거로는 대상 4개 파일 29개 테스트와 전체 15개 파일 81개 테스트가 통과했다.

[2026-08-25 11:14] - 스레드 기반 심사 UI 구현

### DISCOVERED ISSUES

- type 5 deferred 원본을 나중에 webhook으로 수정하는 기존 흐름은 입력 UI가 불편하고 interaction token 수명에 결과 게시가 결합되어 있었다.
- interaction callback 메시지는 HTTP 응답 뒤 생성되므로 prepare SQS worker가 원본 메시지보다 먼저 실행될 수 있다.
- 버튼 뒤에 작성된 메시지를 worker 조회 시점 기준으로 모으면 사용자가 승인하지 않은 추가 내용이 snapshot에 섞일 수 있다.

### DECISIONS

- `/심사`는 설정 채널에서 즉시 공개 anchor를 반환하고 prepare job을 1초 지연한다. Judge Lambda가 public thread와 소유자 전용 버튼을 준비하며 새 상시 리소스는 추가하지 않는다.
- 버튼 claim 시각을 DynamoDB에 저장하고 Discord thread를 최대 5페이지·500개까지만 조회한다. 그중 claim 시각 이전 소유자의 최신 type 0 non-bot 텍스트 최대 100개를 오래된 순으로 정렬해 Unicode 6,000자로 현재 snapshot한다.
- component는 guild, owner, anchor message, parent/thread channel, configVersion, deadline을 모두 일치시킨 뒤 `draft → queued`를 조건부 claim한다.
- worker는 `queued → judging` 8분 lease와 판결·통계·session 단일 transaction을 사용한다. 빈 제출과 크레딧 소진은 draft/button을 복구하고, 안정 메시지와 판결은 bot REST의 stable anchor edit만 사용한다.

### FAILED APPROACHES

- 최초 전체 check는 Prettier가 10개 변경 파일의 형식을 거부했다. 프로젝트 config를 명시한 formatting 후 재검증했다.
- 두 번째 전체 check는 사용하지 않는 runtime 상수와 type-only import를 ESLint가 거부했다. literal type과 type import로 보정했다.
- 세 번째 전체 check는 테스트 mock이 인자 없는 함수로 추론되어 typed request를 읽지 못했다. `ModelClient['create']` 시그니처로 mock 경계를 지정했다.

### LEARNINGS

- message에서 시작한 Discord public thread의 ID는 source message ID와 같으므로 GET channel 확인 후 POST thread 생성으로 prepare retry를 멱등 처리할 수 있다.
- 필요한 Discord permission 정수는 기존 설치 값 `311385213952`와 일치하며 View/Send/Embed/Read History/Create Public Threads/Send in Threads/Use Commands를 포함한다.
- `pnpm build && pnpm check`는 16개 파일 103개 테스트, format, ESLint, strict typecheck, bundle load까지 통과했다. interaction bundle에는 OpenAI key, bot token, Luna model marker가 없다.

### NEXT TASK TIPS

- 다음 배포에서는 Discord command 재등록으로 옵션 없는 `/심사` manifest를 동기화하고, Message Content Intent 및 thread 권한 smoke check가 통과해야 한다.
- production 수동 QA는 `/심사` → thread 작성 → owner 버튼 → stable anchor 판결 → `/내기록` 1회 증가 순서로 수행한다. 외부 배포는 Task 7 executor 범위에서 수행하지 않았다.

[2026-08-25 11:29] - Task 7 Root review 기록 정합화

### DISCOVERED ISSUES

- 최초 기록은 thread API 조회 자체를 최대 100개로 표현했지만 실제 보정 구현은 최대 5페이지·500개를 bounded pagination한 뒤 최신 소유자 메시지 최대 100개를 snapshot한다.
- retry release와 실제 draft reopen을 같은 상태 정리로 취급하면 `claimedAt`이 사라져 SQS 재시도에서 버튼 이후 메시지가 포함될 수 있다.
- Discord message timestamp는 UTC `Z`뿐 아니라 유효한 ISO 8601 offset을 반환할 수 있다.
- 권한 점검 문서가 debug 채널과 submission 채널을 일반적으로 동일시했으나, 이는 현재 production 설정에만 해당하는 전제다.

### DECISIONS

- Discord timestamp 경계는 Zod datetime의 offset 허용으로 검증한다.
- retry release는 `claimedAt`을 보존하고, 사용자가 다시 버튼을 누르는 draft reopen에서만 `claimedAt`을 제거한다.
- thread 조회는 최대 5페이지·500개로 제한하고, 필터 이후 최신 소유자 일반 텍스트 최대 100개를 오래된 순으로 AI에 전달한다.
- Discord setup 문서는 현재 production에서 debug와 submission이 같은 채널이므로 debug 채널 권한 smoke가 submission 권한도 검증한다는 전제를 명시한다.

### FAILED APPROACHES

- 없음. Root review의 코드·테스트·문서 보정 결과를 기록 파일에만 동기화했다.

### LEARNINGS

- API pagination 상한과 AI snapshot 메시지 상한은 별개다. 운영 기록에는 `5 pages/500 fetched → latest 100 owner messages → 6,000 characters` 순서를 구분해 적어야 한다.
- 재시도 lease 해제는 사용자 의도의 시간 경계를 초기화하는 reopen과 동일한 전이가 아니다.

### NEXT TASK TIPS

- production에서 debug와 submission 채널을 분리하면 `check-discord-setup.ts`가 submission 채널을 별도로 조회·검증하도록 환경 계약을 확장해야 한다.
- 다음 전체 검증·배포 보고에는 Root review 이후 실제 테스트 수와 CI/Deploy run을 기준으로 기록을 갱신한다.

[2026-08-25 11:40] - Task 7 최종 pre-commit 보정 기록

### DISCOVERED ISSUES

- 버튼 claim 뒤 guild 설정이 바뀌면 기존 회차를 계속 심사할 수 없지만, 단순 retry 상태로 남기면 같은 비회복 오류가 SQS에서 반복된다.
- 설정 변경 취소 안내의 anchor 수정이 일시 실패할 수 있으므로 저장 상태만으로 다음 delivery에서 같은 안내를 다시 만들 수 있어야 한다.
- Discord thread 생성의 403은 권한 설정 전에는 회복되지 않지만, 400/404는 callback message/thread 생성 경쟁으로 발생할 수 있어 같은 비재시도 분류를 적용하면 안 된다.

### DECISIONS

- 설정 불일치 회차는 `cancelled`로 영구 전이하고, 이후 delivery는 저장된 cancelled 상태에서 동일한 anchor 안내를 deterministic하게 재게시한다.
- thread 생성 HTTP 403만 비재시도 권한 부족으로 처리한다. HTTP 400/404는 source message ID의 thread 존재 여부를 GET으로 재확인하고, race로 이미 생성됐으면 재사용하며 없으면 오류를 유지해 SQS가 재시도한다.
- 관련 narrow 테스트 47개 통과 뒤 Root의 `pnpm build && pnpm check`에서 16개 파일 111개 테스트와 build/format/ESLint/strict typecheck가 모두 통과했다. 추가 검사는 `credential_pattern_hits=0`, `tracked_env_files=0`, `interaction_secret_markers=0`, cached diff check 통과다.

### FAILED APPROACHES

- 없음. 코드 review 보정 결과를 기록 파일에만 동기화했다.

### LEARNINGS

- 비회복 설정 불일치에는 retry 상태가 아니라 terminal 상태와 deterministic renderer가 필요하다.
- 동일한 Discord 4xx라도 403 권한 오류와 400/404 생성 경쟁은 재시도 정책이 달라야 한다.

### NEXT TASK TIPS

- 최종 로컬 검증은 16개 파일 111개 테스트와 자격증명·환경파일·interaction secret marker 0건으로 확정했다. 다음 단계는 이 증거를 유지한 채 commit/push/deploy 결과를 별도로 기록하는 것이다.
- 배포 smoke에서 403 권한 안내가 나오면 Developer Portal과 submission 채널의 Create Public Threads/Send Messages in Threads 권한을 먼저 확인한다.

[2026-08-25 12:32] - Discord component ACK 경계

### LEARNINGS

- Discord application command의 `data.id`는 snowflake 문자열이지만 message component의 `data.id`는 32-bit 정수이며 legacy component는 `0`을 보낼 수 있다. 공용 interaction parser에서 두 형태를 구분해 수용해야 한다.
- component interaction은 3초 안에 초기 응답이 필요하다. 버튼 경로는 signed 요청을 request-review SQS에 기록한 뒤 type 6으로 ACK하고, DynamoDB 조건부 권한 검증·상태 전이·AI 처리는 Judge worker에서 수행한다.

[2026-08-25 13:08] - 스레드 항소 판결 교정

### DECISIONS

- 항소는 최초 회차에 포함되며 최대 2회다. 성공한 AI 재심만 횟수를 차감하고, 본인 반박 없음·크레딧 소진은 기존 판결과 버튼을 복구한다.
- 직전 판결 뒤부터 클릭 시점까지의 새 메시지만 항소 자료로 사용한다. 제출자 반박을 필수로 하고, 다른 작성자는 `참여자 N`으로 익명화해 참고 진술로만 전달한다.
- 항소 결과는 새 심사 횟수나 생존 연속을 늘리지 않는다. 현재 판정별 횟수와 징계 점수만 교정하고, 이전·새 판결은 회차별 immutable 항소 record로 남긴다.

### LEARNINGS

- 항소의 멱등성은 Discord interaction request ID, session 상태·lease, verdict revision, appeal record 조건을 함께 사용해야 AI 호출·횟수·통계의 중복 반영을 막을 수 있다.
- 현재 verdict 교체, 통계 교정, 항소 횟수 증가, 감사 record 저장은 한 DynamoDB transaction이어야 한다.
- 항소 claim 전에 읽은 verdict는 경쟁 worker의 확정 직후 stale할 수 있다. claim에 실패해 finalized anchor를 복구할 때는 current verdict를 consistent read로 다시 조회해야 한다.

### NEXT TASK TIPS

- production 배포 뒤 기존 finalized anchor는 자동 이벤트가 없으므로 새 판결부터 항소 버튼이 표시된다. 과거 anchor에 버튼이 필요하면 별도 안전한 재렌더 절차를 승인받아 수행한다.
