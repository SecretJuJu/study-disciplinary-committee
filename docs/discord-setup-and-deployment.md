# Discord 설정·배포·사용 런북

> 상태: production 자동 배포 기준
>
> 비밀 값은 이 문서와 command line 인자에 기록하지 않는다.

## 1. Developer Portal 설정

1. Guild Install을 활성화한다.
2. Install scopes에서 `bot`, `applications.commands`를 선택한다.
3. bot 권한은 `View Channel`, `Send Messages`, `Embed Links`, `Read Message History`, `Create Public Threads`, `Send Messages in Threads`, `Use Application Commands`를 선택한다.
4. Bot 페이지에서 **Message Content Intent**를 켠다. 소유자의 thread 텍스트 snapshot을 읽는 데 필요하다.
5. `Administrator`, Presence Intent, Server Members Intent, 채널 관리, `Manage Roles`는 현재 범위에 필요 없다.
6. General Information의 Application ID와 Public Key를 bootstrap 변수로 사용한다.
7. Bot Token은 GitHub Actions secret과 Pulumi/Secrets Manager 경로로만 전달한다.
8. bot과 관리자만 볼 수 있는 debug text channel을 만들고 ID를 `DISCORD_DEBUG_CHANNEL_ID`로 설정한다.

Interactions Endpoint URL은 직접 붙여넣을 필요가 없다. `master` 배포 workflow가 Pulumi의 HTTPS output으로 갱신하고 Discord PING 검증을 통과시킨다.

## 2. 명령 사용법

배포 시 guild command는 아래 네 개만 동기화된다. `/help`의 내용도 같은 manifest에서 생성되므로 등록된 입력 형식과 함께 바뀐다.

```text
/help
/설정 보기
/설정 저장 제출채널:#채널 판결채널:#채널
/심사
/내기록
```

- `/심사`를 실행하면 bot이 공개 접수 메시지와 public thread를 만든다.
- 생성된 thread에 학습 내용을 여러 메시지로 작성한 뒤 anchor의 `⚖️ 심사 요청` 버튼을 누른다.
- 최근 thread 메시지를 최대 500개까지만 제한적으로 조회하고, 그중 소유자의 최신 일반 텍스트 최대 100개·6,000자만 심사한다. attachment, system/bot/다른 사용자 메시지는 무시한다.
- `/설정 보기`와 `/설정 저장`은 서버 관리 권한이 있어야 한다.
- `/설정 저장` 전에는 `/심사`를 실행할 수 없다.

`/help`, `/설정`, `/내기록`은 OpenAI 없이 코드와 DynamoDB로 즉시 응답한다. `/심사`만 OpenAI를 사용한다. Lambda 스트리밍이나 무기한 “생각 중” 표시는 사용하지 않는다. prepare와 judge-thread 작업은 기존 SQS/Judge Lambda가 처리하고, 최종 판결은 bot REST로 고정 anchor 메시지를 수정한다.

## 3. 설정 저장 동작

`/설정 저장`은 다음 DynamoDB item을 생성하거나 갱신한다.

```text
PK=GUILD#{guildId}
SK=SETTINGS
```

최초 저장 기본값은 `Asia/Seoul`, 1일 주기, 제출 창 60분, 역할 자동 변경 off, `configVersion=1`이다. 재저장은 기존 정책을 보존하고 두 채널을 바꾸며 configVersion을 하나 올린다. 조건부 갱신이므로 동시에 오래된 설정을 저장하려 하면 실패한다.

1일 주기와 제출 창 값은 향후 Scheduler용 설정이다. 현재 배포는 정기 소환·마감 Scheduler와 역할 자동 변경을 활성화하지 않는다. `/심사`는 사용자가 직접 실행하는 ad-hoc 심사다.

## 4. 자동 배포

```text
master push
  → Node 24 + pnpm frozen install
  → format + ESLint + strict typecheck + Vitest + build
  → GitHub OIDC로 AWS 역할 획득
  → Pulumi production 적용
  → Discord endpoint 갱신
  → guild command 4개 동기화
  → Discord identity/guild/debug channel 권한 확인
  → debug channel 테스트 메시지
```

배포는 [자동 배포 bootstrap](bootstrap-and-environment.md)의 repository variables/secrets가 준비되어 있어야 한다. workflow는 `master` push에서만 실행되고 production deployment concurrency를 직렬화한다.

## 5. Discord 자동 점검

로컬에 bot token을 안전하게 주입할 수 있을 때만 다음을 실행한다.

```bash
DISCORD_SEND_TEST_MESSAGE=false pnpm check:discord
```

필수 환경변수는 `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_DEBUG_CHANNEL_ID`다. 기본값은 테스트 메시지 전송이므로 읽기 점검만 하려면 반드시 `DISCORD_SEND_TEST_MESSAGE=false`를 사용한다.

스크립트는 bot identity, guild membership, endpoint, 설정된 debug 채널의 소유 guild, `View Channel`/`Send Messages`/`Embed Links`/`Read Message History`/`Create Public Threads`/`Send Messages in Threads`, Message Content Intent, 등록 command 수를 검사한다. 현재 production은 debug 채널과 제출 채널을 같은 채널로 사용한다. Deploy workflow에서는 테스트 메시지 전송까지 허용한다. token과 원시 Discord 응답은 출력하지 않는다.

등록 명령 수는 반드시 `4`여야 한다. endpoint에 서명 없는 POST를 보내면 HTTP `401`이어야 한다.

## 6. 운영 디버깅

Judge의 재시도 가능한 실패는 debug channel에 안전한 원인 코드와 상관 ID만 게시한다. 제출 원문, token, secret, 사용자 입력, 원시 exception은 금지한다. Discord 알림 실패는 원래 SQS 실패를 숨기지 않으며 message는 재시도 후 DLQ로 이동한다.

같은 안전 진단은 Judge Lambda의 CloudWatch Logs에 `event=operational_diagnostic` JSON으로도 기록된다. AWS CLI에서는 `aws logs tail /aws/lambda/<judge-function> --since 30m`으로 확인한다. 로그에도 제출 원문·token·secret·원시 오류는 포함하지 않는다.

`ai_credit_exhausted`는 OpenAI 프로젝트 크레딧이 0일 때 발생하는 비재시도 오류다. 이 경우 bot은 회차를 draft로 다시 열고 고정 anchor에 충전 안내와 `⚖️ 심사 요청` 버튼을 복구한다. [OpenAI Billing](https://platform.openai.com/settings/organization/billing/)에서 크레딧을 추가한 뒤 기존 thread에서 버튼을 다시 누르면 된다.

제출 채널에 thread 생성 권한이 없으면 접수 메시지가 관리자 권한 확인 안내로 바뀌고 재시도나 DLQ 이동 없이 종료된다. 접수 뒤 `/설정 저장`으로 채널이나 정책 버전이 바뀐 회차도 자동 재시도하지 않고 취소하며, 현재 제출 채널에서 새 `/심사`를 실행하도록 안내한다.

그 외 AI 실패는 `ai_output_incomplete` 또는 `ai_output_invalid`, Discord REST 실패는 `discord_service_unavailable` 또는 `discord_request_rejected`로 구분한다. 재시도 가능한 오류는 회차를 queued로 돌리고 SQS가 다시 심사한다. 판결이 이미 저장된 경우 AI와 통계를 반복하지 않고 고정 anchor 게시만 재시도한다.

Discord에서 직접 확인할 최소 시나리오는 다음 순서다.

1. 관리자가 `/설정 저장`을 실행한다.
2. `/설정 보기`에서 채널과 기본값을 확인한다.
3. `/help`에서 위 명령 형식이 표시되는지 확인한다.
4. `/내기록`에서 신규 사용자는 0회 통계를 받는지 확인한다.
5. 설정된 제출 채널에서 `/심사`를 실행해 공개 thread가 생기는지 확인한다.
6. thread에 학습 내용을 작성하고 `⚖️ 심사 요청`을 눌러 anchor가 최종 판결문으로 바뀌는지 확인한다.
7. 같은 사용자의 `/내기록` 집계가 1회 증가하는지 확인한다.
8. SQS judge queue와 DLQ backlog가 0인지 확인한다.

6번은 실제 OpenAI 과금이 발생하는 수동 검증이다. 자동 배포 smoke는 OpenAI 심사를 호출하지 않는다.
