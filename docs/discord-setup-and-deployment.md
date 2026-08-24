# Discord 설정 및 배포 런북

> 상태: bootstrap 및 자동 배포 workflow 구현됨; 외부 실행은 미수행
>
> 이 문서는 비밀 값을 기록하지 않는다.

## 1. 사전 조건

- GitHub 저장소와 `master` 브랜치
- AWS 계정, 비용 알림 수신 이메일, `ap-northeast-2` 사용 가능 여부
- Pulumi state용 S3 bucket을 만들 수 있는 AWS 관리자 권한
- 개발 전용 Discord test guild와 운영 Discord guild
- OpenAI API 프로젝트와 `gpt-5.6-luna` 접근 권한

## 2. Discord Developer Portal

1. Discord Developer Portal에서 Application을 만든다.
2. **Installation**에서 Guild Install만 켠다.
3. Default Install Settings에 `bot`, `applications.commands` scopes를 넣는다.
4. 권한은 `View Channel`, `Send Messages`, `Embed Links`, `Use Application Commands`만 먼저 선택한다. 역할 변경을 실제로 켤 때만 `Manage Roles`를 추가한다.
5. **General Information**에서 Application ID와 Public Key를 기록한다. Public Key는 `DISCORD_PUBLIC_KEY` 환경설정에 둔다.
6. **Bot**에서 Bot Token을 생성하고 즉시 AWS Secrets Manager의 `APP_SECRETS` JSON에 저장한다. OpenAI 키도 같은 secret의 별도 JSON 필드에 저장한다. 토큰은 문서·Pulumi output·GitHub Actions log에 넣지 않는다.
7. 첫 `master` 배포 뒤 workflow가 Pulumi output의 HTTPS URL을 **Interactions Endpoint URL**로 등록한다. Discord가 보내는 PING에 `{ "type": 1 }`로 응답하고 서명 검증이 통과해야 저장된다.
8. 설치 링크로 test guild에 봇을 추가한다. 운영 guild에는 smoke test 후 설치한다.
9. bot과 관리자 역할만 접근 가능한 `#bot-debug` 텍스트 채널을 만들고 channel ID를 Pulumi stack config의 `debugChannelId`로 설정한다. interaction token·제출 원문을 보거나 일반 사용자가 쓸 수 있는 채널은 지정하지 않는다.

### 설치·권한 자동 점검

아래 환경변수를 설정한 뒤 진단 스크립트를 실행한다.

```bash
export DISCORD_APPLICATION_ID='...'
export DISCORD_BOT_TOKEN='...'
export DISCORD_GUILD_ID='...'
export DISCORD_DEBUG_CHANNEL_ID='...'
pnpm check:discord
```

스크립트는 봇 identity와 guild membership을 확인하고, guild role과 채널 permission overwrite를 Discord 순서로 계산하여 `View Channel`, `Send Messages`, `Embed Links`를 검증한다. 필수 권한이 모두 있으면 debug 채널에 멘션이 차단된 embed 테스트 메시지를 보낸다. 메시지 전송 없이 읽기 점검만 하려면 `DISCORD_SEND_TEST_MESSAGE=false`를 함께 설정한다. 토큰과 원시 API 응답은 출력하지 않는다.

Guild Install에는 `applications.commands`와 `bot` scope가 필요하며, 서버에서 동작할 권한은 bot 권한으로 관리된다. [Discord 시작 가이드](https://docs.discord.com/developers/quick-start/getting-started)

## 3. 명령 등록 전략

### 개발

- `DISCORD_COMMAND_GUILD_ID`를 test guild ID로 설정한다.
- `pnpm register:commands --guild $DISCORD_COMMAND_GUILD_ID`를 실행한다.
- guild 명령은 즉시 갱신되므로 modal, 버튼, 권한을 반복 검증한다.

### 출시

- global command payload를 코드에서 생성해 `PUT /applications/{application.id}/commands`로 동기화한다.
- command 등록은 infrastructure 변경과 분리된 deploy job에서 실행한다.
- payload diff가 없으면 Discord API를 호출하지 않는다.
- global 명령 등록 후 test guild에서 실제 `/내기록`, `/설정`, 제출 modal을 한 번 더 확인한다.

명령은 HTTP로만 등록하며 guild 명령은 빠른 테스트를 위해 즉시 갱신된다. [Discord Application Commands](https://docs.discord.com/developers/interactions/application-commands)

## 4. AWS·Pulumi 초기 부트스트랩

1. [자동 배포 bootstrap](bootstrap-and-environment.md)의 환경변수를 준비한다.
2. 관리자 AWS profile과 `gh auth login` 상태에서 `bash scripts/bootstrap-deployment.sh`를 한 번 실행한다.
3. 생성된 AWS account ID, S3 backend URL, GitHub OIDC role ARN이 의도한 대상인지 확인한다.
4. workflow와 코드를 `master`에 push한다.
5. Pulumi가 API Gateway, Lambda, DynamoDB, SQS/DLQ, Scheduler IAM role, Secrets Manager, CloudWatch, Budget를 만들고 Discord endpoint와 guild commands를 동기화한다.

## 5. GitHub Actions 및 OIDC

### AWS trust

1. bootstrap이 GitHub OIDC provider와 `disciplinary-committee-github-deploy` 역할을 만든다.
2. trust policy의 `sub`는 해당 저장소의 `master` 브랜치와 audience `sts.amazonaws.com`으로 정확히 제한된다.
3. 역할에는 프로젝트 prefix의 Pulumi 리소스와 state prefix에 필요한 권한만 부여한다. `AdministratorAccess`는 부여하지 않는다.

GitHub OIDC는 장기 AWS access key를 GitHub secret에 보관하지 않고 AWS 접근을 제공한다. trust policy에서 `sub` 조건을 제한해야 한다. [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)

### 워크플로

| 파일         | 트리거            | 수행                                                                    |
| ------------ | ----------------- | ----------------------------------------------------------------------- |
| `ci.yml`     | PR, `master` push | Node 24/pnpm 설치, format, lint, typecheck, test, build                 |
| `deploy.yml` | `master` push     | CI 재검증, OIDC, `pulumi up`, Discord 동기화, 권한 점검과 테스트 메시지 |

`permissions`는 `contents: read`, 배포 job에만 `id-token: write`를 둔다. GitHub secret은 command output에 출력하지 않는다. [Pulumi GitHub Actions](https://www.pulumi.com/docs/iac/operations/continuous-delivery/github-actions/)

## 6. 배포 순서와 롤백

1. CI 통과와 Pulumi preview를 검토한다.
2. Lambda·테이블·큐를 배포한다.
3. dev Discord endpoint PING과 서명 실패 테스트를 수행한다.
4. test guild 명령을 등록하고 `/설정`, 소환, 제출, 판결, 마감, 주간 결산을 검증한다.
5. production 승인을 받고 `pulumi up`을 실행한다.
6. production endpoint를 Discord Portal에 등록하고 global commands를 동기화한다.
7. 운영 guild에서 관리자만 대상으로 1회 smoke session을 실행한다.

롤백은 애플리케이션 버전의 재배포와 `pulumi up`으로 수행한다. DynamoDB 삭제·테이블 교체는 rollback 명령에 포함하지 않는다. 판결 오류는 자동으로 되돌리지 않고 `/점수조정`과 감사 기록으로 보정한다.

## 7. 운영 점검표

- [ ] `#bot-debug` 채널은 관리자와 bot만 접근 가능하며 일반 운영 채널과 분리되어 있다.
- [ ] `/help`는 모든 guild 구성원에게 보이고, `/운영상태`·`/최근오류`는 관리자만 실행할 수 있다.
- [ ] Discord debug alert에는 오류 코드·상관 ID만 있으며 제출 원문·토큰·원시 오류 메시지가 없다.
- [ ] DLQ가 비어 있다.
- [ ] Scheduler의 활성 schedule 수와 GuildSettings가 일치한다.
- [ ] Lambda error/throttle 알람이 없다.
- [ ] OpenAI 월 예상 비용이 $2 이하다.
- [ ] AWS monthly forecast가 $2 이하다.
- [ ] 역할 변경 사용 서버에서 봇 역할이 대상 역할보다 높다.
- [ ] Discord public key와 bot token이 현재 값이다.
