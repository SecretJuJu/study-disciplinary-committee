export type ApplicationCommand = {
  type: 1;
  name: string;
  description: string;
  integration_types: [0];
  contexts: [0];
  default_member_permissions?: string;
  options?: readonly { type: number; name: string; description: string; required?: boolean }[];
};
const manageGuild = '32';
export const commands: readonly ApplicationCommand[] = [
  {
    type: 1,
    name: 'help',
    description: '징계위원회 명령과 운영 안내를 확인합니다.',
    integration_types: [0],
    contexts: [0],
  },
  {
    type: 1,
    name: '위원회',
    description: '징계위원회를 시작하거나 중지합니다.',
    integration_types: [0],
    contexts: [0],
    default_member_permissions: manageGuild,
    options: [{ type: 3, name: '동작', description: 'start 또는 stop', required: true }],
  },
  {
    type: 1,
    name: '설정',
    description: '서버별 심사 설정을 변경합니다.',
    integration_types: [0],
    contexts: [0],
    default_member_permissions: manageGuild,
  },
  {
    type: 1,
    name: '내기록',
    description: '개인 생존 및 징계 기록을 확인합니다.',
    integration_types: [0],
    contexts: [0],
  },
  {
    type: 1,
    name: '징계현황',
    description: '서버의 징계위원회 현황을 확인합니다.',
    integration_types: [0],
    contexts: [0],
  },
  {
    type: 1,
    name: '최근판결',
    description: '최근 판결문을 확인합니다.',
    integration_types: [0],
    contexts: [0],
    default_member_permissions: manageGuild,
  },
  {
    type: 1,
    name: '점수조정',
    description: '사용자의 징계 점수를 조정합니다.',
    integration_types: [0],
    contexts: [0],
    default_member_permissions: manageGuild,
  },
  {
    type: 1,
    name: '기록초기화',
    description: '사용자 기록을 초기화합니다.',
    integration_types: [0],
    contexts: [0],
    default_member_permissions: manageGuild,
  },
  {
    type: 1,
    name: '운영상태',
    description: '큐, 비용 제한, 최근 처리 상태를 확인합니다.',
    integration_types: [0],
    contexts: [0],
    default_member_permissions: manageGuild,
  },
  {
    type: 1,
    name: '최근오류',
    description: '최근 운영 오류의 안전한 요약을 확인합니다.',
    integration_types: [0],
    contexts: [0],
    default_member_permissions: manageGuild,
  },
];
