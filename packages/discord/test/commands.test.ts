import { describe, expect, it } from 'vitest';

import { commandHelp, commands, createCommandHelp } from '../src/index.js';

describe('command manifest', () => {
  it('publishes only the four active guild commands', () => {
    expect(commands.map((command) => command.name)).toEqual(['help', '설정', '심사', '내기록']);
    expect(
      commands.every((command) => command.integration_types[0] === 0 && command.contexts[0] === 0),
    ).toBe(true);
    expect(commands.find((command) => command.name === '설정')?.default_member_permissions).toBe(
      '32',
    );
    expect(commands.find((command) => command.name === 'help')?.default_member_permissions).toBe(
      undefined,
    );
  });

  it('declares settings subcommands and Discord text-channel inputs', () => {
    const settings = commands.find((command) => command.name === '설정');
    expect(settings?.options).toEqual([
      expect.objectContaining({ type: 1, name: '보기' }),
      expect.objectContaining({
        type: 1,
        name: '저장',
        options: [
          expect.objectContaining({
            type: 7,
            name: '제출채널',
            required: true,
            channel_types: [0],
          }),
          expect.objectContaining({
            type: 7,
            name: '판결채널',
            required: true,
            channel_types: [0],
          }),
        ],
      }),
    ]);
  });

  it('declares bounded required and optional study inputs', () => {
    const study = commands.find((command) => command.name === '심사');
    expect(study?.options).toEqual([
      expect.objectContaining({
        type: 3,
        name: '학습내용',
        required: true,
        min_length: 1,
        max_length: 1_500,
      }),
      expect.objectContaining({
        type: 4,
        name: '학습시간',
        min_value: 1,
        max_value: 1_440,
      }),
      expect.objectContaining({ type: 3, name: '배운점', max_length: 1_000 }),
    ]);
  });
});

describe('command help', () => {
  it('derives every executable usage from the registered manifest', () => {
    expect(commandHelp).toBe(createCommandHelp(commands));
    expect(commandHelp).toContain('`/help`');
    expect(commandHelp).toContain('`/설정 보기`');
    expect(commandHelp).toContain('`/설정 저장 <제출채널:#채널> <판결채널:#채널>`');
    expect(commandHelp).toContain('`/심사 <학습내용:텍스트> [학습시간:숫자] [배운점:텍스트]`');
    expect(commandHelp).toContain('`/내기록`');
    expect(commandHelp).not.toContain('/운영상태');
  });

  it('stays within one Discord message', () => {
    expect(commandHelp.length).toBeLessThanOrEqual(2_000);
  });
});
