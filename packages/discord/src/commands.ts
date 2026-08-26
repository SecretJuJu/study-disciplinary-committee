const applicationCommandType = 1 as const;
const subcommandOptionType = 1 as const;
const integerOptionType = 4 as const;
const channelOptionType = 7 as const;
const guildInstallType = 0 as const;
const guildContextType = 0 as const;
const guildTextChannelType = 0 as const;
const manageGuildPermission = '32';

type CommandOptionBase = {
  name: string;
  description: string;
};

export type StringCommandOption = CommandOptionBase & {
  type: 3;
  required?: boolean;
  min_length?: number;
  max_length?: number;
};

export type IntegerCommandOption = CommandOptionBase & {
  type: typeof integerOptionType;
  required?: boolean;
  min_value?: number;
  max_value?: number;
};

export type ChannelCommandOption = CommandOptionBase & {
  type: typeof channelOptionType;
  required?: boolean;
  channel_types: readonly [typeof guildTextChannelType];
};

export type CommandValueOption = StringCommandOption | IntegerCommandOption | ChannelCommandOption;

export type SubcommandOption = CommandOptionBase & {
  type: typeof subcommandOptionType;
  options?: readonly CommandValueOption[];
};

export type ApplicationCommand = {
  type: typeof applicationCommandType;
  name: string;
  description: string;
  integration_types: readonly [typeof guildInstallType];
  contexts: readonly [typeof guildContextType];
  default_member_permissions?: typeof manageGuildPermission;
  options?: readonly (SubcommandOption | CommandValueOption)[];
};

export const commands: readonly ApplicationCommand[] = [
  {
    type: applicationCommandType,
    name: 'help',
    description: '사용 가능한 명령과 입력 방법을 확인합니다.',
    integration_types: [guildInstallType],
    contexts: [guildContextType],
  },
  {
    type: applicationCommandType,
    name: '설정',
    description: '서버의 제출 및 판결 설정을 관리합니다.',
    integration_types: [guildInstallType],
    contexts: [guildContextType],
    default_member_permissions: manageGuildPermission,
    options: [
      {
        type: subcommandOptionType,
        name: '보기',
        description: '현재 서버 설정을 확인합니다.',
      },
      {
        type: subcommandOptionType,
        name: '저장',
        description: '채널을 저장하고 나머지 정책은 안전한 기본값을 사용합니다.',
        options: [
          {
            type: channelOptionType,
            name: '제출채널',
            description: '학습 심사를 접수할 텍스트 채널입니다.',
            required: true,
            channel_types: [guildTextChannelType],
          },
          {
            type: channelOptionType,
            name: '판결채널',
            description: '심사 결과를 게시할 텍스트 채널입니다.',
            required: true,
            channel_types: [guildTextChannelType],
          },
        ],
      },
    ],
  },
  {
    type: applicationCommandType,
    name: '심사',
    description: '공개 스레드에 학습 내용을 작성해 심사를 요청합니다.',
    integration_types: [guildInstallType],
    contexts: [guildContextType],
  },
  {
    type: applicationCommandType,
    name: '내기록',
    description: '내 심사 횟수와 누적 징계 점수를 확인합니다.',
    integration_types: [guildInstallType],
    contexts: [guildContextType],
  },
];

function renderValueOption(option: CommandValueOption): string {
  const valueHint =
    option.type === channelOptionType
      ? '#채널'
      : option.type === integerOptionType
        ? '숫자'
        : '텍스트';
  const value = `${option.name}:${valueHint}`;
  return option.required === true ? `<${value}>` : `[${value}]`;
}

function renderUsage(command: ApplicationCommand, subcommand?: SubcommandOption): string {
  const options =
    subcommand?.options ?? command.options?.filter((option) => option.type !== 1) ?? [];
  const optionUsage = options.map(renderValueOption).join(' ');
  const commandPath = `/${command.name}${subcommand === undefined ? '' : ` ${subcommand.name}`}`;
  return `${commandPath}${optionUsage.length === 0 ? '' : ` ${optionUsage}`}`;
}

export function createCommandHelp(manifest: readonly ApplicationCommand[] = commands): string {
  const lines = manifest.flatMap((command) => {
    const subcommands = command.options?.filter(
      (option): option is SubcommandOption => option.type === subcommandOptionType,
    );
    const adminLabel =
      command.default_member_permissions === manageGuildPermission ? ' · 관리자 전용' : '';

    if (subcommands !== undefined && subcommands.length > 0) {
      return subcommands.map(
        (subcommand) =>
          `\`${renderUsage(command, subcommand)}\` — ${subcommand.description}${adminLabel}`,
      );
    }

    return [`\`${renderUsage(command)}\` — ${command.description}${adminLabel}`];
  });

  return [
    '**스터디 징계위원회 사용법**',
    ...lines,
    '',
    '**심사 순서**',
    '1. 설정된 제출 채널에서 `/심사`를 실행합니다.',
    '2. 생성된 공개 스레드에 학습 내용을 메시지로 작성합니다. 최대 20,000자까지 심사합니다.',
    '3. 안내 메시지의 `⚖️ 심사 요청` 버튼을 누릅니다.',
    '4. 판결에 이의가 있으면 스레드에 새 반박을 작성하고 `📣 항소` 버튼을 누릅니다. 항소는 최대 2회입니다.',
    '5. 다른 구성원이 같은 스레드에 남긴 보증·참고 진술도 항소 자료로 검토됩니다.',
    '',
    '<필수>, [선택] 표시를 확인하세요.',
  ].join('\n');
}

export const commandHelp = createCommandHelp();
