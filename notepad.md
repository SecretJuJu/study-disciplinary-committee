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
