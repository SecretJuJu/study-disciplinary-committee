# 징계위원회 MVP 기술 사양

> 상태: 제안
>
> 기준일: 2026-08-24
>
> 목표 예산: 월 미화 $3 전후, 상한 초과 전 알림·차단

## 1. 제품과 범위

징계위원회는 Discord 서버에서 정해진 주기로 학습 내용을 제출받아 AI가 `유의미`, `미흡`, `무의미`로 판정하고, 불출석·징계 점수·생존 기록을 갱신하는 봇이다.

MVP에는 서버별 설정, 정기 소환, 제출·마감, AI 판결문, 점수·생존 기록, 개인/서버 현황, 기본 역할 변경, 주간 결산을 포함한다. 재심, 추가 질문, 증거 링크 분석, 외부 활동 연동, 실제 채널 제재는 제외한다.

## 2. 핵심 결정

| 영역   | 결정                                                           | 이유                                                        |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------- |
| 런타임 | Node.js 24, TypeScript, ESM, pnpm workspace                    | 최신 Lambda 관리 런타임과 단일 언어 운영                    |
| 컴퓨팅 | API Gateway HTTP API + AWS Lambda                              | Discord HTTP Interactions에 맞고 상시 Gateway 연결이 불필요 |
| 비동기 | SQS + Lambda                                                   | Discord 3초 응답 제한과 AI 지연/재시도를 분리               |
| 스케줄 | EventBridge Scheduler                                          | 서버별 정기 소환과 회차별 단발 마감을 신뢰성 있게 실행      |
| 저장소 | DynamoDB on-demand + PITR                                      | 낮은 유휴 비용, 조건부/트랜잭션 쓰기, 운영 부담 최소화      |
| AI     | OpenAI Responses API, `gpt-5.6-luna`, `reasoning.effort: high` | 요청한 모델·사고 수준을 유지하면서 낮은 토큰 단가           |
| IaC    | Pulumi TypeScript                                              | 앱과 인프라를 같은 언어·타입으로 관리                       |
| CI/CD  | GitHub Actions + GitHub OIDC + Pulumi                          | 장기 AWS 키 없이 `master` push 자동 배포                    |
| 리전   | `ap-northeast-2` 기본                                          | 한국 Discord 서버의 지연시간을 우선; 요금은 배포 전 재확인  |

OpenAI 공식 문서상 Luna는 대량·비용 민감 작업용이고 입력 $0.20/MTok, 출력 $1.20/MTok이며 `high` reasoning과 Structured Outputs를 지원한다. [OpenAI Luna 모델](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

## 3. 시스템 구조

```text
Discord Slash Command / Button / Modal
             │ HTTPS + Ed25519 signature
             ▼
API Gateway HTTP API ──► interaction Lambda ──► DynamoDB
                                  │
                                  ├──► SQS: judge queue ──► judge Lambda ──► OpenAI
                                  │                                  │
                                  │                                  └──► Discord REST API
                                  │
EventBridge Scheduler ──► summon/deadline Lambda ───────────► Discord REST API
                                  │
                                  └──► DynamoDB / SQS

SQS DLQ ◄── 모든 비동기 소비자 실패       CloudWatch Alarms ──► 운영자 알림
                                                          │
judge/scheduler 실패 ──► 안전 진단 이벤트 ──► 운영자 전용 Discord 디버그 채널
```

### Lambda 책임

| 함수           | 트리거                | 책임                                                           |
| -------------- | --------------------- | -------------------------------------------------------------- |
| `interactions` | Discord HTTP POST     | 서명 검증, PING, 명령/버튼/modal 처리, 즉시 또는 deferred 응답 |
| `scheduler`    | EventBridge Scheduler | 소환 생성, 마감 처리, 주간 결산 생성                           |
| `judge`        | SQS                   | 제출 스냅샷을 심사하고 판결·통계를 원자적으로 확정             |
| `outbox`       | SQS                   | Discord REST 메시지 전송을 재시도 가능하게 수행                |
| `dlq-monitor`  | EventBridge 또는 수동 | DLQ 관찰·재처리 도구; 자동 재판결은 하지 않음                  |
| `diagnostics`  | judge/scheduler 실패  | 안전한 오류 코드·상관 ID를 운영자 전용 Discord 채널로 전송     |

HTTP Interaction은 원문 body의 `X-Signature-Ed25519`와 timestamp를 검증해야 하며 실패 시 401을 반환한다. 또한 최초 응답은 3초 안에 보내야 한다. AI 처리는 deferred 응답 뒤 큐에서 수행한다. [Discord Interaction 개요](https://docs.discord.com/developers/interactions/overview) · [응답 규칙](https://docs.discord.com/developers/interactions/receiving-and-responding)

## 4. 상태 전이와 정확성

```text
SCHEDULED → OPEN → SUBMITTED → JUDGING → FINALIZED
                 └──────────→ ABSENT_FINALIZED
```

- `ReviewSession`의 마감 시각은 UTC ISO-8601, 화면 표시는 서버의 IANA timezone으로 변환한다.
- 소환 시 `OPEN` 세션을 조건부 생성한다. 이미 존재하면 중복 Scheduler 이벤트는 no-op이다.
- 제출은 `OPEN`에서만 허용하며, 판결 전에는 `revision`을 증가시켜 수정한다.
- `judge`는 최신 제출 스냅샷만 사용하고 `FINALIZED` 조건부 트랜잭션으로 판결·점수·통계를 함께 기록한다.
- 마감과 제출·심사 경합은 DynamoDB 조건식과 트랜잭션으로 해결한다. 늦게 도착한 이벤트가 이미 확정된 세션을 바꾸지 못한다.
- 설정 변경 시 `configVersion`을 올린다. 이전 버전 Scheduler 이벤트는 현재 설정을 읽어 무효화한다.
- EventBridge Scheduler에는 retry policy와 SQS DLQ를 설정한다. Scheduler의 DLQ·재시도 지원은 AWS 문서로 확인했다. [AWS Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule.html)

## 5. DynamoDB 단일 테이블 설계

테이블: `disciplinary-committee-{env}`. 모든 데이터는 `PK`, `SK`와 필요한 GSI만 사용한다.

| 레코드      | PK / SK                                       | 주요 속성                                                          |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------ |
| 서버 설정   | `GUILD#{guildId}` / `SETTINGS`                | enabled, timezone, cadence, 채널·역할 ID, 점수 규칙, configVersion |
| 회차        | `GUILD#{guildId}` / `SESSION#{sessionId}`     | state, openAt, deadlineAt, 대상 역할, counts, TTL                  |
| 제출        | `SESSION#{sessionId}` / `SUBMISSION#{userId}` | revision, 학습 내용, 제출 시각, contentHash                        |
| 판결        | `SESSION#{sessionId}` / `VERDICT#{userId}`    | outcome, pointsDelta, 판결문, prompt/model 버전, usage             |
| 사용자 통계 | `GUILD#{guildId}` / `USER#{userId}`           | points, survival totals/streaks, lastVerdict                       |
| 주간 집계   | `GUILD#{guildId}` / `WEEK#{isoWeek}`          | 집계값, publishedAt                                                |
| 멱등성 키   | `IDEMPOTENCY#{source}` / `{eventId}`          | 처리 결과, TTL                                                     |

GSI는 `GSI1PK = GUILD#{guildId}#STATUS#{status}`로 현 징계 대상 조회, `GSI2PK = USER#{userId}`로 개인 기록 페이지네이션에만 사용한다. Discord 표시 이름은 저장하지 않고 요청 시의 이름만 출력한다.

### 보존 정책

- 제출 원문: 90일 TTL. 판결·통계는 원문 없이 유지한다.
- SQS 메시지: 최대 14일; DLQ도 14일.
- CloudWatch 구조 로그: 14일 보존, 제출 원문·토큰·비밀 값 기록 금지.
- 관리자가 `/기록삭제`를 실행하면 사용자별 제출·판결 원문·통계를 비동기 삭제한다. 백업/복구 정책은 구현 전에 별도 확정한다.

## 6. 컨텍스트와 기억 최적화

### 원칙

AI에 대화 전체, 이전 판결문 전체, Discord 채널 이력을 보내지 않는다. 이 제품의 판정은 장기 대화가 아니라 특정 회차의 제출 근거에 관한 것이므로, 장기 기억은 데이터베이스의 사실 상태로 관리하고 요청마다 최소 컨텍스트를 조립한다.

### 심사 요청 구성

1. **고정 prefix**: 심사 기준, 금지 표현, JSON schema, 판결문 말투. 모든 요청에서 바이트 단위로 동일하게 유지한다.
2. **서버 정책**: `미흡` 점수, 역할 변경 활성화 여부 등 판정에 필요한 설정만 포함한다.
3. **현재 제출 스냅샷**: 무엇을/얼마나/무엇을 얻었는지와 revision.
4. **짧은 사용자 상태**: 현재 점수, 면제 사용 가능 여부. 판정 등급에는 영향을 주지 못하게 명시한다.
5. **출력 제한**: rationale 300자, verdictText 500자 이하, follow-up 없음(MVP).

이 구조에서 AI는 `previous_response_id`나 `reasoning.context: all_turns`를 사용하지 않는다. 요청 사이에 추론 상태가 누적되면 이전 회차의 문맥·편향·토큰이 불필요하게 들어온다. 대신 `store: false`, `reasoning.context: current_turn`을 명시하고 판결 결과만 DynamoDB에 저장한다. OpenAI는 GPT-5.6에서 전 턴 reasoning이 기본일 수 있으므로, 명시적 current-turn 설정이 필요하다. [OpenAI 모델 가이드](https://developers.openai.com/api/docs/guides/latest-model)

### 비용·일관성 장치

- 고정 prefix는 명시적 prompt-cache breakpoint 후보로 설계하되, 낮은 트래픽 MVP에서는 cache write 비용도 함께 관찰한다.
- 제출 글자 수는 2,000자, 입력 총량은 3,000 토큰, 출력은 700 토큰으로 상한을 둔다.
- `high`는 유지하되, 판정 세트 50건으로 `medium`과 블라인드 비교한다. 유의미한 품질 차이가 없으면 `medium`으로 내리는 것은 별도 결정이다.
- 각 요청의 input/output/cached 토큰, latency, outcome을 저장하고 월별 예산 집계만 보관한다.
- 프롬프트·schema·모델 식별자를 판결과 함께 보관해 재현성과 품질 회귀를 확인한다.

### Structured Output 계약

```ts
type Judgment = {
  outcome: 'meaningful' | 'insufficient' | 'meaningless';
  rationale: string;
  verdictText: string;
  confidence: 'low' | 'medium' | 'high';
};
```

`outcome`을 점수 규칙에 매핑하는 것은 애플리케이션 코드의 책임이다. AI는 점수·역할을 직접 결정하거나 Discord API를 호출하지 않는다. Responses API의 JSON Schema Structured Outputs를 사용한다. [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses)

## 7. Discord 기능 설계

### 설치 및 권한

MVP는 Guild Install만 지원한다. Install scopes는 `bot`, `applications.commands`이며 권한은 다음 최소 집합이다.

- 필수: `View Channel`, `Send Messages`, `Embed Links`, `Use Application Commands`
- 선택: `Manage Roles` — 서버 관리자가 역할 변경 기능을 활성화한 경우만 요청/검증

`Administrator`, 메시지 내용 읽기, 멤버 목록 읽기, 채널 관리, timeout 권한은 요청하지 않는다. Discord는 필요한 최소 권한만 요청하라고 안내한다. [Discord OAuth2와 권한](https://docs.discord.com/developers/platform/oauth2-and-permissions)

역할 변경 전 `/설정 역할`은 봇의 최고 역할보다 대상 역할이 낮은지 검증한다. Discord 역할 계층상 봇은 자기보다 낮은 역할만 부여/수정할 수 있다. 실패 시 징계 자체는 확정하되 역할 동기화 실패를 관리자에게 알린다. [Discord 역할 계층](https://docs.discord.com/developers/topics/permissions)

### 명령과 인터랙션

| 표면   | 명령/동작                                                                        | 권한                                 |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------ |
| 관리자 | `/위원회 시작`, `/위원회 중지`, `/설정`, `/최근판결`, `/점수조정`, `/기록초기화` | Discord `Manage Guild`를 앱에서 확인 |
| 사용자 | `/내기록`, `/징계현황`, `제출` 버튼, 제출 modal                                  | Guild 구성원                         |
| 시스템 | 소환 메시지, 판결문, 주간 결산                                                   | 설정된 채널                          |

### Discord 운영 디버깅

한 서버를 직접 운영하는 MVP를 위해 별도의 `DISCORD_DEBUG_CHANNEL_ID`를 둔다. 이 채널은 봇과 관리자만 볼 수 있게 만들고, 일반 학습·판결 채널과 분리한다. 채널 ID 자체는 비밀이 아니지만 Pulumi stack config로만 주입하며, 저장소·로그에 적지 않는다.

- `judge`와 `scheduler`가 재시도 가능한 실패를 만나면 `component`, 안전한 `code`, 짧은 고정 요약, UTC 시각, 상관 ID만 전송한다. 실패는 다시 던져 SQS/Scheduler의 재시도와 DLQ 흐름을 그대로 유지한다.
- 제출 원문, Discord interaction token, bot token, OpenAI 키, 원시 exception message, 사용자 ID는 알림에 넣지 않는다. Discord REST 전송에는 `allowed_mentions.parse: []`를 사용하여 실수로 멘션을 발생시키지 않는다.
- 오류 알림 자체가 실패해도 원래 작업의 재시도를 막지 않는다. Outbox 전송 실패는 같은 채널로 재귀 알림하지 않고, DLQ 및 CloudWatch alarm으로 관찰한다.
- 알림 폭주 방지는 DynamoDB TTL 기반 fingerprint별 15분 1건·하루 20건 상한으로 구현한다. 상한 초과분은 CloudWatch metric으로만 집계한다. 이 제한이 적용되기 전에는 debug channel을 운영 채널로 사용하지 않는다.

운영자 명령은 `/운영상태`(큐, 최근 처리 시각, 비용 차단 상태)와 `/최근오류`(최근 안전 진단 요약)로 제공한다. 둘 다 `Manage Guild` 기본 권한이며, Discord 서버 설정의 앱 권한도 추가로 제한한다. Discord의 `default_member_permissions`는 기본값일 뿐 서버별 override가 가능하므로 런타임에서도 `Manage Guild`를 fail-closed로 재검증한다. [Discord Application Commands](https://docs.discord.com/developers/interactions/application-commands)

명령 정의는 코드에서 선언하고 CI 배포 뒤 별도 `register-commands` 작업으로 HTTP API에 동기화한다. 개발은 test guild 명령을 사용해 즉시 확인하고, 출시 직전에 global 명령으로 전환한다. Discord는 guild 명령이 즉시 갱신되며 global 명령은 공개 준비 후 사용하도록 안내한다. [Discord Application Commands](https://docs.discord.com/developers/interactions/application-commands)

## 8. 인프라·비밀·관측성

- Lambda는 VPC에 넣지 않는다. OpenAI·Discord로의 NAT 비용을 피하고 AWS 관리형 공개 엔드포인트를 사용한다.
- Secrets Manager에는 `APP_SECRETS` 한 개의 JSON secret으로 `OPENAI_API_KEY`, `DISCORD_BOT_TOKEN`을 저장한다. Lambda 역할은 해당 secret의 read와 필요한 DynamoDB/SQS/CloudWatch 권한만 갖는다. 회전 자동화는 MVP에서 하지 않는다.
- Pulumi state는 bootstrap이 만든 private/versioned S3 backend에 저장한다. secret config는 별도의 긴 passphrase로 암호화하고 passphrase는 GitHub Actions secret에 둔다. KMS 고정 월 비용과 Pulumi Cloud token을 피하면서 단일 운영자 환경의 복구 가능성을 유지한다. [Pulumi state backend](https://www.pulumi.com/docs/iac/concepts/state-and-backends/)
- API Gateway WAF는 공개 운영 전 추가한다. MVP는 Discord signature validation, request-size 제한, CloudWatch alarm으로 시작한다.
- 알람: DLQ 메시지 1건 이상, Lambda error 1건 이상, judge p95 > 20초, OpenAI 월 예상비용 > $2, AWS 월 비용 forecast > $2. Discord debug 알림은 알람의 보조 관측 수단이며 CloudWatch/DLQ를 대체하지 않는다.

## 9. 월 예산

비용은 사용량과 AWS 계정의 Free Tier 자격에 따라 달라지므로 보장은 하지 않는다. **월 $3은 기능이 아니라 운영 한도**다. 베타는 최대 1개 서버·30명·일 1회(월 최대 900 심사)로 시작하며, 계정별 심사 쿼터를 강제한다. 서버를 늘리기 전에 실제 토큰 사용량을 확인한다.

| 항목                            | 가정                                                      | 목표 월 비용                                                                           |
| ------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| OpenAI Luna                     | 심사당 입력 최대 3,000 / 출력 최대 700 토큰, high         | 텍스트 토큰 상한상 약 $0.00144/심사, 900회에 약 $1.30 이하; reasoning 토큰은 실측 필요 |
| Lambda/API Gateway/SQS/DynamoDB | 소규모 베타, no VPC/NAT                                   | 대체로 무료 구간 또는 수 센트                                                          |
| EventBridge Scheduler           | 소환·마감·주간 결산                                       | 무료 구간                                                                              |
| Secrets Manager/CloudWatch      | JSON secret 1개, 14일 로그, 표준 해상도 알람 최대 10개    | 약 $0.40부터; Free Tier 여부·리전 가격에 따라 변동                                     |
| 합계                            | AWS Free Tier 자격/리전 가격과 reasoning 토큰에 따라 변동 | $2~$3 목표                                                                             |

EventBridge Scheduler는 월 1,400만 호출 무료 구간을 제공하고, Lambda는 월 100만 요청과 400,000 GB-초 무료 구간을 제공한다. [EventBridge 요금](https://aws.amazon.com/eventbridge/pricing/) · [Lambda 요금](https://aws.amazon.com/lambda/pricing/)

**비용 차단 규칙:** AI 심사 쿼터를 기본 월 900회로 제한한다. 일별 토큰/비용 추정치가 $2.00을 넘으면 새 심사를 일시 중지하고 관리자에게 알린다. AWS Budget의 월 $3 알람과 $5 초과 알람을 만들고, $5 알람 시 Scheduler를 일괄 비활성화하는 수동 런북을 제공한다. OpenAI는 프로젝트별 hard spend limit가 가능한지 계정 UI에서 확인한 뒤 $2.50 soft limit를 설정한다. 계정별 사용 가능 여부는 본 문서에서 가정하지 않는다.

## 10. 저장소 구조

```text
apps/
  bot-api/                  # Lambda 진입점
packages/
  domain/                   # 상태 전이, 점수, Zod 스키마
  discord/                  # 요청 검증, 응답과 REST client
  ai-judge/                 # prompt, JSON schema, OpenAI adapter
  persistence/              # DynamoDB repository와 transaction
infra/                      # Pulumi TypeScript 프로젝트
docs/                       # 이 문서와 계획·운영 절차
.github/workflows/          # 검증·preview·배포
```

## 11. 비기능 완료 기준

- Discord signature 실패·오래된 timestamp·중복 interaction은 안전하게 거절 또는 no-op한다.
- 동일 회차의 중복 Scheduler/SQS 전달에도 사용자 통계는 한 번만 갱신된다.
- AI/Discord 장애는 DLQ에서 관찰 가능하고, 원문 제출을 잃지 않는다.
- AI 요청에 현재 심사에 무관한 이전 제출 원문을 포함하지 않는다.
- PR은 lint/typecheck/test/Pulumi preview를 통과해야 한다.
- 프로덕션 배포 role의 OIDC subject는 해당 저장소의 `master` 브랜치로 제한한다.
