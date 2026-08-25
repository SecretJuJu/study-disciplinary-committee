# 징계위원회 배포 기술 사양

> 상태: production 구현·배포 기준
>
> 기준일: 2026-08-25
>
> 목표 예산: 월 미화 $3 전후

## 1. 현재 활성 범위

현재 Discord guild에 등록하는 application command는 정확히 네 개다.

| 명령                                 | 실행 주체             | 처리 방식                                                                             |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------- |
| `/help`                              | 모든 구성원           | 코드가 manifest에서 사용법을 만들어 type 4 ephemeral로 즉시 응답                      |
| `/설정 보기`                         | `Manage Guild` 보유자 | DynamoDB 설정을 조회해 type 4 ephemeral로 즉시 응답                                   |
| `/설정 저장 제출채널 판결채널`       | `Manage Guild` 보유자 | DynamoDB 설정을 조건부 저장하고 type 4 ephemeral로 즉시 응답                          |
| `/심사 학습내용 [학습시간] [배운점]` | 모든 구성원           | 제출 저장과 SQS enqueue 뒤 type 5 deferred 응답, Judge가 OpenAI 결과로 원본 응답 수정 |
| `/내기록`                            | 모든 구성원           | DynamoDB 통계를 조회해 type 4 ephemeral로 즉시 응답                                   |

`/help`, `/설정`, `/내기록`은 OpenAI를 호출하지 않는다. `/심사`만 OpenAI를 사용한다. 정기 소환 Scheduler, 마감 처리, 주간 결산, 역할 자동 변경, outbox 소비 Lambda는 이번 production 활성 범위가 아니다. Pulumi에 scheduler group과 outbox queue가 존재하더라도 트리거와 worker가 연결되지 않았으며, 설정의 역할 변경 기본값도 꺼져 있다.

## 2. 런타임과 구성

| 영역        | 결정                                                           |
| ----------- | -------------------------------------------------------------- |
| 런타임      | Node.js 24, TypeScript strict, ESM source, pnpm workspace      |
| HTTP        | API Gateway HTTP API + Lambda `interactions`                   |
| 비동기 심사 | SQS judge queue + Lambda `judge`                               |
| 저장소      | DynamoDB on-demand, PITR, `expiresAt` TTL                      |
| AI          | OpenAI Responses API, `gpt-5.6-luna`, `reasoning.effort: high` |
| IaC         | Pulumi TypeScript, private/versioned S3 state backend          |
| CI/CD       | GitHub Actions, GitHub OIDC, `master` push 자동 배포           |
| 리전        | `ap-northeast-2`                                               |

Lambda 응답 스트리밍은 사용하지 않는다. Discord의 “생각 중” 표시는 type 5 deferred acknowledgement이며, Judge Lambda가 비동기 처리 후 Discord webhook의 원본 interaction 응답을 수정한다.

```text
Discord
  │ signed POST
  ▼
API Gateway ──► interactions Lambda
                    ├─ help/settings/stats ──► type 4 ephemeral
                    └─ review ──► DynamoDB + SQS ──► type 5 deferred
                                                   │
                                                   ▼
                                             judge Lambda
                                              ├─ Secrets Manager
                                              ├─ OpenAI Responses API
                                              ├─ DynamoDB transaction
                                              └─ Discord follow-up edit
```

## 3. Discord 입력과 응답 계약

- `/설정 저장`의 두 채널은 guild text channel만 허용한다.
- `/심사`의 `학습내용`은 1~~1,500자, `학습시간`은 1~~1,440분, `배운점`은 1~1,000자다.
- Discord payload, command option, snowflake ID, SQS body는 경계에서 Zod로 검증한다.
- `default_member_permissions=32`에 더해 `/설정 보기`와 `/설정 저장` 모두 런타임에서 `Manage Guild`를 fail-closed로 확인한다.
- 모든 즉시 응답은 요청자만 보는 ephemeral이다. 심사 판결은 최초 deferred 응답을 수정한다.
- 서명 검증 실패 및 unsigned request는 HTTP 401이다.

## 4. 설정과 기억

Guild 설정은 단일 테이블의 다음 키에 저장한다.

```text
PK = GUILD#{guildId}
SK = SETTINGS
```

최초 `/설정 저장` 기본값은 다음과 같다.

- `enabled: true`
- `timezone: Asia/Seoul`
- `cadenceMinutes: 1440` (1일)
- `submissionWindowMinutes: 60`
- `roleChangesEnabled: false`
- 도메인의 기본 점수 정책과 징계 임계값
- `configVersion: 1`

기존 설정 갱신은 채널만 바꾸고 정책을 보존하며 `configVersion`을 1 올린다. DynamoDB 조건식은 읽은 버전과 현재 버전이 같은 경우에만 쓰기를 허용해 동시 갱신의 stale write를 차단한다. 정기 Scheduler가 활성화된다는 의미는 아니며, 현재 `cadenceMinutes`와 제출 창은 향후 자동 회차를 위한 저장 값이다.

장기 대화 기억은 사용하지 않는다. AI에는 현재 제출, 현재 누적 징계 점수, 고정 심사 규칙만 전달한다. 이전 제출 원문·판결문·Discord 채널 기록·`previous_response_id`는 보내지 않으며 `store: false`, `reasoning.context: current_turn`을 사용한다. `high` reasoning 토큰과 가시 JSON이 같은 한도를 사용하므로 `max_output_tokens`는 2,000으로 제한한다. 제출 원문과 interaction 기반 회차에는 90일 TTL을 둔다. 판결과 집계는 DynamoDB 조건부 transaction으로 한 번만 반영한다.

## 5. 비동기 신뢰성

- interaction Lambda는 회차와 제출을 transaction으로 저장하고 judge queue enqueue가 성공한 뒤에만 type 5를 반환한다.
- judge event source는 batch size 1과 `ReportBatchItemFailures`를 사용한다.
- judge queue visibility timeout은 540초, Lambda timeout은 90초, 실패 3회 후 DLQ로 이동한다.
- Judge는 이미 확정된 판결을 먼저 확인한다. Discord 후속응답만 실패한 재시도에서는 OpenAI와 통계 갱신을 반복하지 않고 기존 판결을 다시 게시한다.
- 통계 동시 갱신 충돌 시 최신 통계를 다시 읽어 제한적으로 재시도한다.

## 6. 환경변수, secret, IAM

| 함수         | 환경변수 이름                                              | 역할 권한                                                                        |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| interactions | `TABLE_NAME`, `JUDGE_QUEUE_URL`, `DISCORD_PUBLIC_KEY`      | DynamoDB Get/Put/Transact, judge queue SendMessage, logs                         |
| judge        | `TABLE_NAME`, `APP_SECRET_ARN`, `DISCORD_DEBUG_CHANNEL_ID` | DynamoDB Get/Put/Transact, judge queue poll/delete/attributes, secret read, logs |

실제 OpenAI key와 Discord bot token은 Secrets Manager의 JSON secret 한 개에 `OPENAI_API_KEY`, `DISCORD_BOT_TOKEN` 필드로 저장한다. GitHub Actions는 secret 값을 Pulumi encrypted config로 전달하고 출력하지 않는다. interaction Lambda에는 secret read 권한이 없다. runtime role에는 bootstrap이 만든 permissions boundary를 적용한다.

Judge의 `PutItem`은 `dynamodb:EnclosingOperation = TransactWriteItems` IAM 조건으로 transaction 내부 작업에만 제한한다.

## 7. 안전 진단

Judge 실패는 운영자 전용 debug channel에 `component`, 안전한 원인 코드, UTC 시각, 상관 ID만 보낸다. 제출 원문, 사용자 원문, Discord interaction token, bot token, OpenAI key, 원시 exception message는 보내거나 로그에 기록하지 않는다. 진단 전송 실패는 원래 SQS 재시도를 막지 않는다.

동일한 필드만 `event: operational_diagnostic` 구조화 JSON으로 Judge Lambda의 CloudWatch Logs에 기록해 AWS CLI에서도 실패 단계를 확인할 수 있게 한다.

OpenAI가 `credit_balance_exhausted`를 반환하면 안전한 `ai_credit_exhausted`로 변환한다. 크레딧 소진은 같은 요청을 재시도해도 성공하지 않으므로 Discord 원본 응답을 충전 후 재실행 안내로 종료하고 SQS message를 성공 처리한다. `ai_request_failed`, `ai_output_incomplete`, `ai_output_invalid`, `judgment_lookup_failed`, `stats_read_failed`, `judgment_persist_failed`, `discord_service_unavailable`, `discord_request_rejected`는 실패 단계를 구분하면서 원문을 노출하지 않는다. 일시적인 외부 장애와 Discord 게시 실패는 기존 SQS 재시도 정책을 유지한다.

## 8. 품질과 배포

- ESLint, Prettier, TypeScript strict, Vitest를 사용한다.
- 코드 변경의 필수 로컬 검증은 `pnpm build && pnpm check`다.
- PR 및 `master` push에서 CI가 같은 품질 검사를 수행한다.
- `master` push의 Deploy workflow는 GitHub OIDC로 AWS 역할을 획득하고 Pulumi 적용, Discord endpoint 갱신, 네 command 동기화, guild/debug channel 권한과 테스트 메시지를 검증한다.
- 장기 AWS access key는 GitHub에 저장하지 않는다.

## 9. 비용 경계

Pulumi의 AWS Budget 기본 한도는 월 $3이며 실제 비용 80%, 예상 비용 100%에서 이메일 알림을 보낸다. Lambda는 VPC 밖에 두어 NAT 고정비를 피하고 DynamoDB on-demand와 SQS를 사용한다. 예산은 사용량과 계정 Free Tier에 따라 보장되지 않는다. AI 호출은 `/심사`에만 한정되고 누적 문맥을 보내지 않아 토큰 비용을 제한한다.

현재 구현에는 OpenAI 요청 자체를 막는 월별 hard quota가 없다. $3 Budget은 알림 장치이지 자동 차단 장치가 아니므로 운영자는 AWS Budget과 OpenAI usage를 함께 확인해야 한다.
