# GitHub Actions

이 저장소는 `master` push를 production 배포 기준으로 사용한다. `ci.yml`은 PR과 `master`에서 품질 검사를 하고, `deploy.yml`은 `master`에서 동일 검사를 통과한 뒤 Pulumi와 Discord 설정을 반영한다.

## 외부 설정 전제 조건

`scripts/bootstrap-deployment.sh`가 아래 GitHub Actions 설정을 만든다.

- `AWS_ROLE_ARN`, `AWS_REGION`, `PULUMI_BACKEND_URL`, `PULUMI_STACK` repository variables
- Discord application/public/guild/debug channel 식별자 variables
- `OPENAI_API_KEY`, `DISCORD_BOT_TOKEN`, `BUDGET_ALERT_EMAIL`, `PULUMI_CONFIG_PASSPHRASE` secrets
- 해당 repository의 `master`만 신뢰하는 GitHub OIDC AWS role

Pulumi state는 private S3 backend에 두며 Pulumi Cloud token은 사용하지 않는다. 장기 AWS access key도 GitHub에 저장하지 않는다. 전체 목록과 실행법은 [자동 배포 bootstrap](bootstrap-and-environment.md)을 따른다.
