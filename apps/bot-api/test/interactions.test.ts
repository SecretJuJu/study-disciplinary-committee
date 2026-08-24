import nacl from 'tweetnacl';
import { afterEach, describe, expect, it } from 'vitest';

import { handler } from '../src/interactions.js';

const savedPublicKey = process.env.DISCORD_PUBLIC_KEY;

afterEach(() => {
  if (savedPublicKey === undefined) {
    delete process.env.DISCORD_PUBLIC_KEY;
  } else {
    process.env.DISCORD_PUBLIC_KEY = savedPublicKey;
  }
});

describe('interaction Lambda', () => {
  it('returns PONG only after signature verification', async () => {
    const keyPair = nacl.sign.keyPair();
    process.env.DISCORD_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('hex');
    const rawBody = '{"type":1,"id":"1","application_id":"2","token":"3"}';
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(`${timestamp}${rawBody}`), keyPair.secretKey),
    ).toString('hex');

    const response = await handler({
      body: rawBody,
      isBase64Encoded: false,
      headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp },
    } as never);

    if (typeof response === 'string') {
      throw new Error('Expected an API Gateway response object.');
    }
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"type":1}');
  });
});
