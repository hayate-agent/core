import { MatrixChannel, matrixOptionsFromEnv } from '../../dist/builtin-plugins/matrix-channel.js';

// Keep the review refusal intact, but keep its complete durable audit JSON out
// of chat. The review store and original transcript are never modified.
export function compactReviewReply(text) {
  const marker = '\n\n⚠️ Review blocked: budget exhausted; operator escalation required.\n';
  const at = text.indexOf(marker);
  if (at < 0) return text;
  const suffix = text.slice(at + marker.length);
  try {
    const state = JSON.parse(suffix);
    if (state.version !== 1 || state.status !== 'escalated' || !Array.isArray(state.rounds)) return text;
    const findings = state.rounds.at(-1)?.findings ?? [];
    const brief = findings.slice(0, 8).map(f => `- ${String(f.severity ?? '')}: ${String(f.title ?? f.id ?? 'Offener Befund').slice(0, 240)}`).join('\n');
    return text.slice(0, at) + marker.trimEnd() + '\n' + brief + '\nVollständige Review-Evidenz bleibt lokal erhalten. Keine Veröffentlichung oder Freigabe; das Review-Budget wurde nicht verändert.';
  } catch { return text; }
}
export class RecoveryMatrixChannel extends MatrixChannel {
  async api(method, path, body, longPollMs = 0) {
    for (let attempt = 0; ; attempt++) {
      try { return await super.api(method, path, body, longPollMs); }
      catch (err) {
        if (err?.status !== 429 || attempt >= 8 || this.abort.signal.aborted) throw err;
        const match = /"retry_after_ms"\s*:\s*(\d+)/.exec(String(err.message));
        const delay = Math.min(60000, Math.max(1000, Number(match?.[1] ?? 5000)) + 250);
        await this.backoff(delay);
      }
    }
  }
  async send(to, text, meta) {
    return super.send(to, compactReviewReply(text), meta);
  }
}
export default {
  apiVersion: 1,
  // Construction is inert. All work uses native host ingress/outbox ownership;
  // inherited MatrixChannel.stop aborts retries/sync and drains delivery/crypto.
  updateAdmission: 'foreground-owned',
  async create(context) {
    const options = matrixOptionsFromEnv(process.env, context.home);
    if (!options) return undefined;
    const approvers = context.approvers.length ? context.approvers : options.approvers?.length ? options.approvers : context.admins ?? [];
    const channel = new RecoveryMatrixChannel({ ...options, approvers, displayName: options.displayName ?? context.agent });
    console.error('[matrix-recovery] factory activated: bounded review summaries and Matrix429 backoff; identity preserved');
    return { channel, home: channel.home, approvers: options.approvers ?? [] };
  }
};
