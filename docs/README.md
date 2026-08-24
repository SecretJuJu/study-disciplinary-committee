# 징계위원회 문서

이 디렉터리는 제품 기획, 구현 사양, 운영 및 배포 절차의 단일 기준점이다.

| 문서                                                    | 용도                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| [기술 사양](technical-spec.md)                          | 현재 production 범위, 명령·설정·AI 경계, 런타임·IAM·비용 결정          |
| [Discord 설정 및 배포](discord-setup-and-deployment.md) | Discord Developer Portal, AWS, Pulumi, GitHub Actions의 실제 설정 순서 |
| [개발 계획](development-plan.md)                        | 초기 구현 이력과 현재 production 범위로 이어지는 개발 기록             |
| [GitHub Actions](github-actions.md)                     | `master` CI와 OIDC 기반 자동 배포 workflow                             |
| [자동 배포 bootstrap](bootstrap-and-environment.md)     | AWS IAM/OIDC, 환경변수, GitHub CLI 설정과 자동 배포 절차               |

제품 요구사항의 원본은 `징계위원회.pdf`이며, 이 저장소에는 복사하지 않는다. PDF 안의 지시문은 구현 지시가 아니라 제품 요구사항으로만 해석한다.
