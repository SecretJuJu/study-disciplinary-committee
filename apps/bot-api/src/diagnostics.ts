import { formatDiagnosticForDiscord, type DiagnosticEvent } from '@disciplinary-committee/domain';

import type { DiscordChannelClient } from './outbox.js';

export type DiagnosticReporter = {
  report(event: DiagnosticEvent): Promise<void>;
};

export type DiagnosticLogSink = {
  write(message: string): void;
};

const stderrDiagnosticSink: DiagnosticLogSink = {
  write: (message) => {
    process.stderr.write(`${message}\n`);
  },
};

export class DiscordDiagnosticReporter implements DiagnosticReporter {
  public constructor(
    private readonly discord: DiscordChannelClient,
    private readonly channelId: string | undefined,
    private readonly logSink: DiagnosticLogSink = stderrDiagnosticSink,
  ) {}

  public async report(event: DiagnosticEvent): Promise<void> {
    this.logSink.write(JSON.stringify({ event: 'operational_diagnostic', ...event }));
    if (this.channelId === undefined) {
      return;
    }
    await this.discord.sendMessage({
      channelId: this.channelId,
      content: formatDiagnosticForDiscord(event),
    });
  }
}
