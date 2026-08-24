# AWS·GitHub 자동 배포 bootstrap

> 기준 브랜치: `master`
>
> 실행 주체: AWS 리소스와 IAM/OIDC를 만들 수 있는 관리자 자격증명

`scripts/bootstrap-deployment.sh`를 한 번 실행하면 Pulumi state용 비공개 S3 bucket, GitHub OIDC provider, `master` 전용 배포 role, repository Actions 변수·시크릿을 구성한다. 이후 `master` push는 CI → build → Pulumi 배포 → Discord endpoint·guild command 동기화를 순서대로 실행한다.

AWS root 사용자는 IAM user가 아니다. 기술적으로 root 자격증명으로도 실행할 수 있지만 장기 access key를 만들지 말고, 가능하면 `AdministratorAccess`가 있는 단기 관리자 profile로 이 bootstrap만 실행한다. GitHub Actions에는 AWS access key를 저장하지 않는다.

## 1. 준비할 값

| 변수                       | 저장 위치                   | 필수 | 설명                                              |
| -------------------------- | --------------------------- | ---- | ------------------------------------------------- |
| `AWS_PROFILE`              | 실행 셸                     | 선택 | bootstrap에 사용할 AWS CLI profile                |
| `AWS_REGION`               | GitHub variable             | 선택 | 기본 `ap-northeast-2`                             |
| `GITHUB_REPOSITORY`        | GitHub 탐지/실행 셸         | 선택 | `owner/repository`; clone 밖에서 실행할 때 명시   |
| `OPENAI_API_KEY`           | GitHub secret→Pulumi secret | 필수 | OpenAI 프로젝트 API key                           |
| `DISCORD_APPLICATION_ID`   | GitHub variable             | 필수 | Discord Application ID                            |
| `DISCORD_PUBLIC_KEY`       | GitHub variable             | 필수 | 64자리 hex public key; 비밀값은 아님              |
| `DISCORD_BOT_TOKEN`        | GitHub secret→Pulumi secret | 필수 | Discord bot token                                 |
| `DISCORD_GUILD_ID`         | GitHub variable             | 필수 | 명령을 등록할 서버 ID                             |
| `DISCORD_DEBUG_CHANNEL_ID` | GitHub variable             | 필수 | bot과 관리자만 볼 수 있는 운영 디버그 채널 ID     |
| `BUDGET_ALERT_EMAIL`       | GitHub secret→Pulumi secret | 필수 | AWS Budget 80% 실제/100% 예상 비용 알림 수신 주소 |
| `PULUMI_CONFIG_PASSPHRASE` | GitHub secret               | 필수 | S3 state의 Pulumi secret 암호화 키                |
| `MONTHLY_BUDGET_USD`       | GitHub variable             | 선택 | 기본 `3`                                          |
| `PULUMI_STACK`             | GitHub variable             | 선택 | 기본 `prod`                                       |

`PULUMI_CONFIG_PASSPHRASE`는 길고 무작위인 값을 사용하고 저장소 밖의 password manager에 복구본을 보관한다. 잃어버리면 S3 state 안의 암호화된 Pulumi config를 해독할 수 없다.

## 2. 한 번만 실행

```bash
cp scripts/bootstrap.env.example scripts/bootstrap.env.local
# scripts/bootstrap.env.local의 값을 채운 뒤 현재 shell에 export한다.
source scripts/bootstrap.env.local
pnpm bootstrap:deployment
```

`scripts/bootstrap.env.local`은 `.gitignore`의 `*.local` 규칙으로 커밋되지 않는다. 실행 전 `aws sts get-caller-identity`와 `gh auth status`로 대상 계정·저장소를 확인한다. 스크립트도 실제 대상 ARN과 repository를 출력한다.

스크립트는 같은 값으로 다시 실행해도 기존 S3 bucket·OIDC provider·role을 갱신하는 방식으로 동작한다. 비밀값은 stdout에 출력하지 않고 `gh secret set`의 stdin으로 전달한다.

## 3. 생성되는 AWS 구성

### Bootstrap 소유 리소스

- S3: `disciplinary-committee-pulumi-state-{accountId}-{region}`
  - public access 전체 차단
  - AES-256 S3 관리형 암호화
  - versioning
  - TLS가 아닌 요청 거부
- OIDC provider: `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`
- IAM role: `disciplinary-committee-github-deploy`
  - trust subject를 `repo:{owner}/{repo}:ref:refs/heads/master`로 정확히 제한
  - GitHub Actions OIDC 단기 자격증명만 허용
- permissions boundary: `disciplinary-committee-runtime-boundary`
  - Pulumi가 runtime role의 inline policy를 바꾸더라도 프로젝트 DynamoDB/SQS/Secret/Lambda/Log 범위를 넘지 못하게 제한

### 배포 role 권한

| 영역                  | 범위                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| Pulumi state S3       | 지정 bucket의 `disciplinary-committee/` prefix만                     |
| DynamoDB/SQS/Lambda   | 이름이 `disciplinary-committee-*`인 프로젝트 리소스                  |
| Secrets Manager       | 이름이 `disciplinary-committee-*`인 secret과 version                 |
| IAM                   | boundary가 강제된 runtime role 관리, Lambda/Scheduler에만 `PassRole` |
| API Gateway           | 지정 리전의 HTTP API 관리                                            |
| EventBridge Scheduler | 프로젝트 schedule group                                              |
| CloudWatch            | 프로젝트 alarm                                                       |
| AWS Budgets           | 월 비용 budget 생성·수정                                             |

GitHub Actions 역할에는 IAM 사용자/access key/OIDC provider 자체를 생성하는 권한이 없다. 그 작업은 로컬 bootstrap 관리자에게만 남긴다.

## 4. `master` push 흐름

```text
master push
  → pnpm frozen install
  → format + ESLint + strict typecheck + tests
  → Lambda bundle build
  → GitHub OIDC로 AWS role 획득
  → S3 backend stack config 동기화
  → pulumi up
  → Pulumi output의 HTTPS endpoint를 Discord Application에 반영
  → guild commands 동기화
```

배포 중간 취소로 state가 불명확해지는 것을 피하기 위해 deployment concurrency는 하나로 직렬화하고 실행 중인 배포는 자동 취소하지 않는다. PR 코드에는 배포 role을 주지 않으며 AWS preview workflow도 두지 않는다.

## 5. 배포 전 확인

1. repository에 `master` 브랜치가 있고 workflow 파일이 커밋되어 있는지 확인한다.
2. Discord bot이 `DISCORD_GUILD_ID` 서버에 설치되어 있는지 확인한다.
3. `DISCORD_DEBUG_CHANNEL_ID` 채널을 일반 사용자가 볼 수 없는지 확인한다.
4. GitHub repository의 Actions variables/secrets에 위 값들이 생성되었는지 확인한다.
5. 첫 push 뒤 Actions log에서 CI, Pulumi, Discord 세 단계가 모두 성공했는지 확인한다.

AWS 공식 문서는 GitHub OIDC trust의 `sub`를 저장소와 브랜치로 제한하도록 안내한다. [AWS GitHub OIDC role](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html) Pulumi S3 backend는 project별 state와 locking을 지원하며 passphrase config는 AES-256-GCM으로 보호된다. [Pulumi state backend](https://www.pulumi.com/docs/iac/concepts/state-and-backends/) Discord Application endpoint는 bot 인증으로 Edit Current Application API에서 갱신할 수 있다. [Discord Application Resource](https://docs.discord.com/developers/resources/application)
