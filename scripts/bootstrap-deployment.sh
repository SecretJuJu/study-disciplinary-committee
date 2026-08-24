#!/usr/bin/env bash
set -euo pipefail

export AWS_PAGER=""

PROJECT_NAME="disciplinary-committee"
DEPLOY_BRANCH="master"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
PULUMI_STACK="${PULUMI_STACK:-prod}"
PULUMI_ENVIRONMENT="${PULUMI_ENVIRONMENT:-prod}"
MONTHLY_BUDGET_USD="${MONTHLY_BUDGET_USD:-3}"
DISCORD_COMMAND_SCOPE="${DISCORD_COMMAND_SCOPE:-guild}"

required_commands=(aws gh)
required_variables=(
  OPENAI_API_KEY
  DISCORD_APPLICATION_ID
  DISCORD_PUBLIC_KEY
  DISCORD_BOT_TOKEN
  DISCORD_GUILD_ID
  DISCORD_DEBUG_CHANNEL_ID
  BUDGET_ALERT_EMAIL
  PULUMI_CONFIG_PASSPHRASE
)

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

for command_name in "${required_commands[@]}"; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "${command_name} is required."
done

missing_variables=()
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    missing_variables+=("${variable_name}")
  fi
done
if (( ${#missing_variables[@]} > 0 )); then
  printf 'Missing required environment variables:\n' >&2
  printf '  - %s\n' "${missing_variables[@]}" >&2
  exit 1
fi

[[ "${DISCORD_APPLICATION_ID}" =~ ^[0-9]{17,20}$ ]] || fail "DISCORD_APPLICATION_ID must be a Discord snowflake."
[[ "${DISCORD_GUILD_ID}" =~ ^[0-9]{17,20}$ ]] || fail "DISCORD_GUILD_ID must be a Discord snowflake."
[[ "${DISCORD_DEBUG_CHANNEL_ID}" =~ ^[0-9]{17,20}$ ]] || fail "DISCORD_DEBUG_CHANNEL_ID must be a Discord snowflake."
[[ "${DISCORD_PUBLIC_KEY}" =~ ^[0-9a-fA-F]{64}$ ]] || fail "DISCORD_PUBLIC_KEY must be a 64-character hex key."
[[ "${MONTHLY_BUDGET_USD}" =~ ^[1-9][0-9]*([.][0-9]{1,2})?$ ]] || fail "MONTHLY_BUDGET_USD must be a positive amount."
[[ "${AWS_REGION}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] || fail "AWS_REGION is invalid."
[[ "${PULUMI_STACK}" =~ ^[A-Za-z0-9_.-]{1,100}$ ]] || fail "PULUMI_STACK is invalid."
[[ "${PULUMI_ENVIRONMENT}" =~ ^[A-Za-z0-9_.-]{1,32}$ ]] || fail "PULUMI_ENVIRONMENT is invalid."
[[ "${BUDGET_ALERT_EMAIL}" =~ ^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$ ]] || fail "BUDGET_ALERT_EMAIL is invalid."
(( ${#PULUMI_CONFIG_PASSPHRASE} >= 24 )) || fail "PULUMI_CONFIG_PASSPHRASE must be at least 24 characters."
[[ "${DISCORD_COMMAND_SCOPE}" == "guild" ]] || fail "Bootstrap supports DISCORD_COMMAND_SCOPE=guild only."

gh auth status >/dev/null 2>&1 || fail "Authenticate GitHub CLI with 'gh auth login' first."

if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" || true
fi
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "Set GITHUB_REPOSITORY=owner/repository or run inside its clone."

AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
[[ "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || fail "Could not resolve a 12-digit AWS account ID."

STATE_BUCKET="${PROJECT_NAME}-pulumi-state-${AWS_ACCOUNT_ID}-${AWS_REGION}"
PULUMI_BACKEND_URL="s3://${STATE_BUCKET}/${PROJECT_NAME}"
ROLE_NAME="${PROJECT_NAME}-github-deploy"
ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"
BOUNDARY_NAME="${PROJECT_NAME}-runtime-boundary"
BOUNDARY_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:policy/${BOUNDARY_NAME}"
OIDC_PROVIDER_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

temporary_directory="$(mktemp -d)"
trap 'rm -rf "${temporary_directory}"' EXIT

printf 'AWS caller: %s\n' "${CALLER_ARN}"
printf 'GitHub repository: %s\n' "${GITHUB_REPOSITORY}"
printf 'Deploy branch: %s\n' "${DEPLOY_BRANCH}"

if ! aws s3api head-bucket --bucket "${STATE_BUCKET}" >/dev/null 2>&1; then
  if [[ "${AWS_REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${STATE_BUCKET}" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "${STATE_BUCKET}" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
fi
aws s3api put-public-access-block \
  --bucket "${STATE_BUCKET}" \
  --public-access-block-configuration \
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
aws s3api put-bucket-versioning \
  --bucket "${STATE_BUCKET}" \
  --versioning-configuration 'Status=Enabled'
aws s3api put-bucket-encryption \
  --bucket "${STATE_BUCKET}" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":false}]}'

cat >"${temporary_directory}/state-bucket-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::${STATE_BUCKET}",
        "arn:aws:s3:::${STATE_BUCKET}/*"
      ],
      "Condition": {"Bool": {"aws:SecureTransport": "false"}}
    }
  ]
}
JSON
aws s3api put-bucket-policy \
  --bucket "${STATE_BUCKET}" \
  --policy "file://${temporary_directory}/state-bucket-policy.json"

if ! aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn "${OIDC_PROVIDER_ARN}" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url 'https://token.actions.githubusercontent.com' \
    --client-id-list 'sts.amazonaws.com' >/dev/null
fi

cat >"${temporary_directory}/runtime-boundary-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ProjectRuntimeData",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:Query", "dynamodb:TransactWriteItems",
        "sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes",
        "secretsmanager:GetSecretValue",
        "lambda:InvokeFunction"
      ],
      "Resource": [
        "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT_ID}:table/${PROJECT_NAME}-*",
        "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT_ID}:table/${PROJECT_NAME}-*/index/*",
        "arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${PROJECT_NAME}-*",
        "arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:${PROJECT_NAME}-*",
        "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${PROJECT_NAME}-*"
      ]
    },
    {
      "Sid": "ProjectRuntimeLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": [
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda/${PROJECT_NAME}-*:log-stream:*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda/${PROJECT_NAME}-*:*"
      ]
    }
  ]
}
JSON

if aws iam get-policy --policy-arn "${BOUNDARY_ARN}" >/dev/null 2>&1; then
  version_count="$(aws iam list-policy-versions --policy-arn "${BOUNDARY_ARN}" --query 'length(Versions)' --output text)"
  if (( version_count >= 5 )); then
    oldest_version="$(aws iam list-policy-versions \
      --policy-arn "${BOUNDARY_ARN}" \
      --query 'sort_by(Versions[?IsDefaultVersion==`false`],&CreateDate)[0].VersionId' \
      --output text)"
    aws iam delete-policy-version --policy-arn "${BOUNDARY_ARN}" --version-id "${oldest_version}"
  fi
  aws iam create-policy-version \
    --policy-arn "${BOUNDARY_ARN}" \
    --policy-document "file://${temporary_directory}/runtime-boundary-policy.json" \
    --set-as-default >/dev/null
else
  aws iam create-policy \
    --policy-name "${BOUNDARY_NAME}" \
    --description "Maximum permissions for ${PROJECT_NAME} runtime roles" \
    --policy-document "file://${temporary_directory}/runtime-boundary-policy.json" \
    --tags Key=Application,Value="${PROJECT_NAME}" Key=ManagedBy,Value=bootstrap >/dev/null
fi

cat >"${temporary_directory}/trust-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {"Federated": "${OIDC_PROVIDER_ARN}"},
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPOSITORY}:ref:refs/heads/${DEPLOY_BRANCH}"
        }
      }
    }
  ]
}
JSON

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "file://${temporary_directory}/trust-policy.json"
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "file://${temporary_directory}/trust-policy.json" \
    --description "Pulumi deploy role for ${GITHUB_REPOSITORY} ${DEPLOY_BRANCH}" \
    --tags Key=Application,Value="${PROJECT_NAME}" Key=ManagedBy,Value=bootstrap >/dev/null
fi

cat >"${temporary_directory}/deploy-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PulumiStateBucketList",
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": "arn:aws:s3:::${STATE_BUCKET}",
      "Condition": {"StringLike": {"s3:prefix": ["${PROJECT_NAME}/*"]}}
    },
    {
      "Sid": "PulumiStateObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${STATE_BUCKET}/${PROJECT_NAME}/*"
    },
    {
      "Sid": "ProjectResources",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable", "dynamodb:DeleteTable", "dynamodb:DescribeTable",
        "dynamodb:UpdateTable", "dynamodb:TagResource", "dynamodb:UntagResource",
        "dynamodb:ListTagsOfResource",
        "dynamodb:DescribeContinuousBackups", "dynamodb:UpdateContinuousBackups",
        "dynamodb:DescribeTimeToLive", "dynamodb:UpdateTimeToLive",
        "sqs:CreateQueue", "sqs:DeleteQueue", "sqs:GetQueueAttributes", "sqs:GetQueueUrl",
        "sqs:ListQueueTags", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue",
        "lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction",
        "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration", "lambda:CreateFunctionUrlConfig",
        "lambda:DeleteFunctionUrlConfig", "lambda:GetFunctionUrlConfig",
        "lambda:UpdateFunctionUrlConfig", "lambda:AddPermission", "lambda:RemovePermission",
        "lambda:GetPolicy", "lambda:ListTags", "lambda:TagResource", "lambda:UntagResource",
        "lambda:CreateEventSourceMapping", "lambda:DeleteEventSourceMapping",
        "lambda:GetEventSourceMapping", "lambda:UpdateEventSourceMapping",
        "secretsmanager:CreateSecret", "secretsmanager:DeleteSecret",
        "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy",
        "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret", "secretsmanager:UpdateSecretVersionStage",
        "secretsmanager:ListSecretVersionIds", "secretsmanager:TagResource", "secretsmanager:UntagResource",
        "cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms", "cloudwatch:PutMetricAlarm",
        "cloudwatch:ListTagsForResource", "cloudwatch:TagResource", "cloudwatch:UntagResource"
      ],
      "Resource": [
        "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT_ID}:table/${PROJECT_NAME}-*",
        "arn:aws:sqs:${AWS_REGION}:${AWS_ACCOUNT_ID}:${PROJECT_NAME}-*",
        "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${PROJECT_NAME}-*",
        "arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:${PROJECT_NAME}-*",
        "arn:aws:cloudwatch:${AWS_REGION}:${AWS_ACCOUNT_ID}:alarm:${PROJECT_NAME}-*"
      ]
    },
    {
      "Sid": "ProjectIamRoles",
      "Effect": "Allow",
      "Action": [
        "iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"
      ],
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT_NAME}-*"
    },
    {
      "Sid": "CreateOrBoundProjectRoles",
      "Effect": "Allow",
      "Action": ["iam:CreateRole", "iam:PutRolePermissionsBoundary"],
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT_NAME}-*",
      "Condition": {"StringEquals": {"iam:PermissionsBoundary": "${BOUNDARY_ARN}"}}
    },
    {
      "Sid": "AttachRuntimeLogPolicy",
      "Effect": "Allow",
      "Action": ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT_NAME}-*",
      "Condition": {
        "ArnEquals": {"iam:PolicyARN": "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"}
      }
    },
    {
      "Sid": "PassProjectRoles",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT_NAME}-*",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": ["lambda.amazonaws.com", "scheduler.amazonaws.com"]
        }
      }
    },
    {
      "Sid": "ApiGatewayAndScheduler",
      "Effect": "Allow",
      "Action": [
        "apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE",
        "scheduler:CreateScheduleGroup", "scheduler:DeleteScheduleGroup",
        "scheduler:GetScheduleGroup", "scheduler:ListTagsForResource",
        "scheduler:TagResource", "scheduler:UntagResource"
      ],
      "Resource": [
        "arn:aws:apigateway:${AWS_REGION}::/apis*",
        "arn:aws:scheduler:${AWS_REGION}:${AWS_ACCOUNT_ID}:schedule-group/${PROJECT_NAME}-*"
      ]
    },
    {
      "Sid": "AccountBudget",
      "Effect": "Allow",
      "Action": [
        "budgets:ModifyBudget", "budgets:ViewBudget", "budgets:ListTagsForResource",
        "budgets:TagResource", "budgets:UntagResource",
        "aws-portal:ModifyBilling", "aws-portal:ViewBilling"
      ],
      "Resource": "*"
    }
  ]
}
JSON
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${PROJECT_NAME}-pulumi-deploy" \
  --policy-document "file://${temporary_directory}/deploy-policy.json"

set_gh_variable() {
  gh variable set "$1" --body "$2" --repo "${GITHUB_REPOSITORY}"
}

set_gh_secret() {
  printf '%s' "$2" | gh secret set "$1" --repo "${GITHUB_REPOSITORY}"
}

set_gh_variable AWS_REGION "${AWS_REGION}"
set_gh_variable AWS_ROLE_ARN "${ROLE_ARN}"
set_gh_variable RUNTIME_PERMISSIONS_BOUNDARY_ARN "${BOUNDARY_ARN}"
set_gh_variable PULUMI_BACKEND_URL "${PULUMI_BACKEND_URL}"
set_gh_variable PULUMI_STACK "${PULUMI_STACK}"
set_gh_variable PULUMI_ENVIRONMENT "${PULUMI_ENVIRONMENT}"
set_gh_variable MONTHLY_BUDGET_USD "${MONTHLY_BUDGET_USD}"
set_gh_variable DISCORD_APPLICATION_ID "${DISCORD_APPLICATION_ID}"
set_gh_variable DISCORD_PUBLIC_KEY "${DISCORD_PUBLIC_KEY}"
set_gh_variable DISCORD_COMMAND_SCOPE "${DISCORD_COMMAND_SCOPE}"
set_gh_variable DISCORD_GUILD_ID "${DISCORD_GUILD_ID}"
set_gh_variable DISCORD_DEBUG_CHANNEL_ID "${DISCORD_DEBUG_CHANNEL_ID}"
set_gh_secret OPENAI_API_KEY "${OPENAI_API_KEY}"
set_gh_secret DISCORD_BOT_TOKEN "${DISCORD_BOT_TOKEN}"
set_gh_secret PULUMI_CONFIG_PASSPHRASE "${PULUMI_CONFIG_PASSPHRASE}"
set_gh_secret BUDGET_ALERT_EMAIL "${BUDGET_ALERT_EMAIL}"

printf '\nBootstrap configuration applied.\n'
printf 'State backend: %s\n' "${PULUMI_BACKEND_URL}"
printf 'Deploy role: %s\n' "${ROLE_ARN}"
printf 'Next: commit the workflow and push to %s.\n' "${DEPLOY_BRANCH}"
