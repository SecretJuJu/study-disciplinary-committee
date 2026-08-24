import { describe, expect, it } from 'vitest';
import { OutboxWorker } from '../src/outbox.js';
describe('OutboxWorker', () => {
  it('validates messages before sending them', async () => {
    const sent: string[] = [];
    const worker = new OutboxWorker({
      sendMessage: async ({ content }) => {
        sent.push(content);
      },
    });
    await worker.process({ channelId: '123456789012345678', content: '판결문' });
    await expect(worker.process({ channelId: 'bad', content: 'x' })).rejects.toThrow();
    expect(sent).toEqual(['판결문']);
  });
});
