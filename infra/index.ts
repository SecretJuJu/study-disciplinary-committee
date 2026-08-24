import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const environment = config.require('environment');
const monthlyBudgetUsd = config.getNumber('monthlyBudgetUsd') ?? 3;
const discordPublicKey = config.require('discordPublicKey');
const discordDebugChannelId = config.require('discordDebugChannelId');
const runtimePermissionsBoundaryArn = config.require('runtimePermissionsBoundaryArn');
const budgetAlertEmail = config.requireSecret('budgetAlertEmail');
const openaiApiKey = config.requireSecret('openaiApiKey');
const discordBotToken = config.requireSecret('discordBotToken');
const name = `disciplinary-committee-${environment}`;
const tags = {
  Application: 'disciplinary-committee',
  Environment: environment,
  ManagedBy: 'pulumi',
};

const table = new aws.dynamodb.Table(`${name}-table`, {
  billingMode: 'PAY_PER_REQUEST',
  hashKey: 'PK',
  rangeKey: 'SK',
  attributes: [
    { name: 'PK', type: 'S' },
    { name: 'SK', type: 'S' },
  ],
  ttl: { attributeName: 'expiresAt', enabled: true },
  pointInTimeRecovery: { enabled: true },
  tags,
});
const judgeDlq = new aws.sqs.Queue(`${name}-judge-dlq`, {
  messageRetentionSeconds: 1_209_600,
  tags,
});
const judgeQueue = new aws.sqs.Queue(`${name}-judge`, {
  visibilityTimeoutSeconds: 540,
  redrivePolicy: judgeDlq.arn.apply((deadLetterTargetArn) =>
    JSON.stringify({ deadLetterTargetArn, maxReceiveCount: 3 }),
  ),
  tags,
});
const outboxDlq = new aws.sqs.Queue(`${name}-outbox-dlq`, {
  messageRetentionSeconds: 1_209_600,
  tags,
});
const outboxQueue = new aws.sqs.Queue(`${name}-outbox`, {
  visibilityTimeoutSeconds: 60,
  redrivePolicy: outboxDlq.arn.apply((deadLetterTargetArn) =>
    JSON.stringify({ deadLetterTargetArn, maxReceiveCount: 3 }),
  ),
  tags,
});
const schedulerGroup = new aws.scheduler.ScheduleGroup(`${name}-scheduler-group`, { name, tags });
const secrets = new aws.secretsmanager.Secret(`${name}-app-secrets`, {
  name: `${name}/app-secrets`,
  recoveryWindowInDays: 7,
  tags,
});
const secretVersion = new aws.secretsmanager.SecretVersion(`${name}-app-secrets-version`, {
  secretId: secrets.id,
  secretString: pulumi.jsonStringify({
    OPENAI_API_KEY: openaiApiKey,
    DISCORD_BOT_TOKEN: discordBotToken,
  }),
});

const interactionRole = new aws.iam.Role(`${name}-lambda-role`, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'lambda.amazonaws.com',
  }),
  permissionsBoundary: runtimePermissionsBoundaryArn,
  tags,
});
const judgeRole = new aws.iam.Role(`${name}-judge-role`, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'lambda.amazonaws.com',
  }),
  permissionsBoundary: runtimePermissionsBoundaryArn,
  tags,
});
const schedulerRole = new aws.iam.Role(`${name}-scheduler-role`, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
    Service: 'scheduler.amazonaws.com',
  }),
  permissionsBoundary: runtimePermissionsBoundaryArn,
  tags,
});
new aws.iam.RolePolicyAttachment(`${name}-logs`, {
  role: interactionRole.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});
const judgeLogs = new aws.iam.RolePolicyAttachment(`${name}-judge-logs`, {
  role: judgeRole.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});
new aws.iam.RolePolicy(`${name}-runtime-policy`, {
  role: interactionRole.id,
  policy: pulumi.all([table.arn, judgeQueue.arn]).apply(([tableArn, judgeArn]) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
          Resource: tableArn,
        },
        {
          Effect: 'Allow',
          Action: ['sqs:SendMessage'],
          Resource: judgeArn,
        },
      ],
    }),
  ),
});
const judgeRuntimePolicy = new aws.iam.RolePolicy(`${name}-judge-runtime-policy`, {
  role: judgeRole.id,
  policy: pulumi
    .all([table.arn, judgeQueue.arn, secrets.arn])
    .apply(([tableArn, judgeArn, secretsArn]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['dynamodb:GetItem', 'dynamodb:TransactWriteItems'],
            Resource: tableArn,
          },
          {
            Effect: 'Allow',
            Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
            Resource: judgeArn,
          },
          {
            Effect: 'Allow',
            Action: ['secretsmanager:GetSecretValue'],
            Resource: secretsArn,
          },
        ],
      }),
    ),
});

const interactions = new aws.lambda.Function(`${name}-interactions`, {
  runtime: 'nodejs24.x',
  role: interactionRole.arn,
  handler: 'interactions.handler',
  timeout: 10,
  memorySize: 256,
  code: new pulumi.asset.FileArchive('../apps/bot-api/dist'),
  environment: {
    variables: {
      TABLE_NAME: table.name,
      JUDGE_QUEUE_URL: judgeQueue.url,
      DISCORD_PUBLIC_KEY: discordPublicKey,
    },
  },
  tags,
});
const judge = new aws.lambda.Function(
  `${name}-judge-worker`,
  {
    runtime: 'nodejs24.x',
    role: judgeRole.arn,
    handler: 'judge-handler.handler',
    timeout: 90,
    memorySize: 512,
    code: new pulumi.asset.FileArchive('../apps/bot-api/dist'),
    environment: {
      variables: {
        TABLE_NAME: table.name,
        APP_SECRET_ARN: secrets.arn,
        DISCORD_DEBUG_CHANNEL_ID: discordDebugChannelId,
      },
    },
    tags,
  },
  { dependsOn: [secretVersion, judgeRuntimePolicy, judgeLogs] },
);
new aws.lambda.EventSourceMapping(`${name}-judge-event-source`, {
  eventSourceArn: judgeQueue.arn,
  functionName: judge.arn,
  batchSize: 1,
  functionResponseTypes: ['ReportBatchItemFailures'],
});
new aws.iam.RolePolicy(`${name}-scheduler-invoke`, {
  role: schedulerRole.id,
  policy: interactions.arn.apply((functionArn) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'lambda:InvokeFunction',
          Resource: functionArn,
        },
      ],
    }),
  ),
});
const api = new aws.apigatewayv2.Api(`${name}-api`, {
  protocolType: 'HTTP',
  tags,
});
const integration = new aws.apigatewayv2.Integration(`${name}-integration`, {
  apiId: api.id,
  integrationType: 'AWS_PROXY',
  integrationUri: interactions.invokeArn,
  payloadFormatVersion: '2.0',
});
new aws.apigatewayv2.Route(`${name}-interactions-route`, {
  apiId: api.id,
  routeKey: 'POST /discord/interactions',
  target: pulumi.interpolate`integrations/${integration.id}`,
});
const stage = new aws.apigatewayv2.Stage(`${name}-stage`, {
  apiId: api.id,
  name: '$default',
  autoDeploy: true,
  tags,
});
new aws.lambda.Permission(`${name}-api-permission`, {
  action: 'lambda:InvokeFunction',
  function: interactions.name,
  principal: 'apigateway.amazonaws.com',
  sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
});
new aws.cloudwatch.MetricAlarm(`${name}-judge-dlq-alarm`, {
  name: `${name}-judge-dlq`,
  namespace: 'AWS/SQS',
  metricName: 'ApproximateNumberOfMessagesVisible',
  dimensions: { QueueName: judgeDlq.name },
  statistic: 'Maximum',
  period: 300,
  evaluationPeriods: 1,
  threshold: 1,
  comparisonOperator: 'GreaterThanOrEqualToThreshold',
  treatMissingData: 'notBreaching',
  tags,
});
new aws.budgets.Budget(`${name}-budget`, {
  name: `${name}-monthly-cost`,
  budgetType: 'COST',
  limitAmount: String(monthlyBudgetUsd),
  limitUnit: 'USD',
  timeUnit: 'MONTHLY',
  costTypes: {
    includeCredit: true,
    includeDiscount: true,
    includeOtherSubscription: true,
    includeRecurring: true,
    includeRefund: false,
    includeSubscription: true,
    includeSupport: true,
    includeTax: true,
    includeUpfront: true,
    useAmortized: false,
    useBlended: false,
  },
  notifications: [
    {
      comparisonOperator: 'GREATER_THAN',
      notificationType: 'ACTUAL',
      threshold: 80,
      thresholdType: 'PERCENTAGE',
      subscriberEmailAddresses: [budgetAlertEmail],
    },
    {
      comparisonOperator: 'GREATER_THAN',
      notificationType: 'FORECASTED',
      threshold: 100,
      thresholdType: 'PERCENTAGE',
      subscriberEmailAddresses: [budgetAlertEmail],
    },
  ],
  tags,
});

export const interactionEndpoint = stage.invokeUrl.apply((url) => `${url}discord/interactions`);
export const appSecretArn = secrets.arn;
export const outboxQueueUrl = outboxQueue.url;
export const schedulerGroupName = schedulerGroup.name;
