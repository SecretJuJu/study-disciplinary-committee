import { formatDiagnosticForDiscord, type DiagnosticEvent } from '@disciplinary-committee/domain';

import type { DiscordChannelClient } from './outbox.js';

export type DiagnosticReporter = {
  report(event: DiagnosticEvent): Promise<void>;
};

export class DiscordDiagnosticReporter implements DiagnosticReporter {
  public constructor(
    private readonly discord: DiscordChannelClient,
    private readonly channelId: string | undefined,
  ) {}

  public async report(event: DiagnosticEvent): Promise<void> {
    if (this.channelId === undefined) {
      return;
    }
    await this.discord.sendMessage({
      channelId: this.channelId,
      content: formatDiagnosticForDiscord(event),
    });
  }
}
