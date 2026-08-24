import { describe, expect, it } from 'vitest';
import { commands } from '../src/index.js';
describe('command manifest', () => {
  it('keeps all commands guild-only and protects administrative commands', () => {
    expect(commands.map((command) => command.name)).toEqual(
      expect.arrayContaining([
        'help',
        '위원회',
        '설정',
        '내기록',
        '징계현황',
        '운영상태',
        '최근오류',
      ]),
    );
    expect(
      commands.every((command) => command.integration_types[0] === 0 && command.contexts[0] === 0),
    ).toBe(true);
    expect(commands.find((command) => command.name === '설정')?.default_member_permissions).toBe(
      '32',
    );
    expect(commands.find((command) => command.name === 'help')?.default_member_permissions).toBe(
      undefined,
    );
    expect(
      commands.find((command) => command.name === '최근오류')?.default_member_permissions,
    ).toBe('32');
  });
});
