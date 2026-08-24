import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import {
  hasManageGuildPermission,
  parseApplicationCommand,
  parseInteraction,
  verifyDiscordRequest,
} from '../src/index.js';

const commandInteraction = (name: string, options?: readonly unknown[]) =>
  parseInteraction(
    JSON.stringify({
      type: 2,
      id: '1541457217830522941',
      application_id: '1541457217830522940',
      token: 'token',
      guild_id: '1541458098101952522',
      member: { user: { id: '1541458098101952523' }, permissions: '32' },
      data: {
        id: '1541457217830522942',
        type: 1,
        name,
        ...(options === undefined ? {} : { options }),
      },
    }),
  );

describe('Discord interaction verification', () => {
  it('accepts a valid current request and rejects a replayed request', () => {
    const keyPair = nacl.sign.keyPair();
    const timestamp = '1724497200';
    const rawBody =
      '{"type":1,"id":"1541457217830522941","application_id":"1541457217830522940","token":"token"}';
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(`${timestamp}${rawBody}`), keyPair.secretKey),
    ).toString('hex');
    const publicKey = Buffer.from(keyPair.publicKey).toString('hex');

    expect(
      verifyDiscordRequest({
        publicKey,
        signature,
        timestamp,
        rawBody,
        now: new Date('2024-08-24T11:00:00.000Z'),
      }),
    ).toBe(true);
    expect(
      verifyDiscordRequest({
        publicKey,
        signature,
        timestamp,
        rawBody,
        now: new Date('2024-08-24T11:06:00.000Z'),
      }),
    ).toBe(false);
  });

  it('fails closed for malformed signatures and missing administrator permissions', () => {
    expect(
      verifyDiscordRequest({ publicKey: 'bad', signature: 'bad', timestamp: '0', rawBody: '{}' }),
    ).toBe(false);
    expect(
      hasManageGuildPermission(
        parseInteraction(
          '{"type":2,"id":"1541457217830522941","application_id":"1541457217830522940","token":"token","member":{"user":{"id":"1541458098101952523"},"permissions":"0"}}',
        ),
      ),
    ).toBe(false);
    expect(() =>
      parseInteraction('{"type":1,"id":"1","application_id":"2","token":"token"}'),
    ).toThrow();
  });
});

describe('application command parsing', () => {
  it('parses settings and study inputs into a typed command', () => {
    expect(
      parseApplicationCommand(
        commandInteraction('설정', [
          {
            type: 1,
            name: '저장',
            options: [
              { type: 7, name: '판결채널', value: '1541458116195917936' },
              { type: 7, name: '제출채널', value: '1541458116195917935' },
            ],
          },
        ]),
      ),
    ).toEqual({
      name: '설정',
      action: '저장',
      submissionChannelId: '1541458116195917935',
      verdictChannelId: '1541458116195917936',
    });

    expect(
      parseApplicationCommand(
        commandInteraction('심사', [
          { type: 3, name: '학습내용', value: '  비동기 큐를 공부했다.  ' },
          { type: 4, name: '학습시간', value: 60 },
          { type: 3, name: '배운점', value: '  중복 전달을 고려해야 한다.  ' },
        ]),
      ),
    ).toEqual({
      name: '심사',
      studyContent: '비동기 큐를 공부했다.',
      durationMinutes: 60,
      learnedText: '중복 전달을 고려해야 한다.',
    });
  });

  it('parses no-input commands and settings view', () => {
    expect(parseApplicationCommand(commandInteraction('help'))).toEqual({ name: 'help' });
    expect(parseApplicationCommand(commandInteraction('내기록', []))).toEqual({ name: '내기록' });
    expect(
      parseApplicationCommand(commandInteraction('설정', [{ type: 1, name: '보기' }])),
    ).toEqual({ name: '설정', action: '보기' });
  });

  it('rejects unknown, missing, duplicate, and incorrectly typed options', () => {
    expect(() => parseApplicationCommand(commandInteraction('삭제'))).toThrow();
    expect(() => parseApplicationCommand(commandInteraction('심사'))).toThrow();
    expect(() =>
      parseApplicationCommand(
        commandInteraction('심사', [
          { type: 3, name: '학습내용', value: '공부함' },
          { type: 3, name: '학습내용', value: '중복' },
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseApplicationCommand(
        commandInteraction('설정', [
          {
            type: 1,
            name: '저장',
            options: [
              { type: 3, name: '제출채널', value: '1541458116195917935' },
              { type: 7, name: '판결채널', value: '1541458116195917936' },
            ],
          },
        ]),
      ),
    ).toThrow();
  });

  it('enforces study input length and duration boundaries', () => {
    expect(
      parseApplicationCommand(
        commandInteraction('심사', [
          { type: 3, name: '학습내용', value: '가'.repeat(1_500) },
          { type: 4, name: '학습시간', value: 1_440 },
          { type: 3, name: '배운점', value: '나'.repeat(1_000) },
        ]),
      ),
    ).toEqual({
      name: '심사',
      studyContent: '가'.repeat(1_500),
      durationMinutes: 1_440,
      learnedText: '나'.repeat(1_000),
    });

    expect(() =>
      parseApplicationCommand(
        commandInteraction('심사', [{ type: 3, name: '학습내용', value: '가'.repeat(1_501) }]),
      ),
    ).toThrow();
    expect(() =>
      parseApplicationCommand(
        commandInteraction('심사', [
          { type: 3, name: '학습내용', value: '공부함' },
          { type: 4, name: '학습시간', value: 0 },
        ]),
      ),
    ).toThrow();
  });
});
