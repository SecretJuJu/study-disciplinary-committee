import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';

import { hasManageGuildPermission, parseInteraction, verifyDiscordRequest } from '../src/index.js';

describe('Discord interaction verification', () => {
  it('accepts a valid current request and rejects a replayed request', () => {
    const keyPair = nacl.sign.keyPair();
    const timestamp = '1724497200';
    const rawBody = '{"type":1,"id":"1","application_id":"2","token":"3"}';
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
          '{"type":2,"id":"1","application_id":"2","token":"3","member":{"user":{"id":"4"},"permissions":"0"}}',
        ),
      ),
    ).toBe(false);
  });
});
