import type { Address, Inbound } from "./types.js";
import { formatSoftwareVersions, type SoftwareVersions } from "./component-versions.js";

/** Resolve an unambiguous existing user channel when no home was configured.
 * Never broadcast across historical rooms or send an obsolete API-run response.
 */
export function startupNoticeTarget(home: Address | undefined,
  sessions: readonly { key: string; replyTo?: Address }[], channels: ReadonlySet<string>): Address | undefined {
  if (home) return channels.has(home.channel) ? home : undefined;
  const targets = new Map<string, Address>();
  for (const session of sessions) {
    const to = session.replyTo;
    if (!to || !channels.has(to.channel) || ["api", "dispatch", "console", "webui"].includes(to.channel) ||
        !session.key.startsWith(`${to.channel}:`)) continue;
    const target = { channel: to.channel, target: to.target };
    targets.set(JSON.stringify(target), target); // one room, even with multiple historical threads
  }
  return targets.size === 1 ? targets.values().next().value : undefined;
}

/** One factual readiness event per runtime boot, delivered by the durable outbox.
 * A delivery-only session keeps it independent of busy/paused business turns.
 * No model prompt, task admission, budget reset or authority change is involved.
 */
export class StartupNotice {
  private announced = false;
  constructor(private readonly options: {
    agent: string;
    build: SoftwareVersions;
    restarted: boolean;
    post: (input: Inbound, text: string) => void;
    log: (message: string) => void;
  }) {}

  /** Call only after channels and startup reconciliation have succeeded. */
  ready(target?: Address): void {
    if (this.announced) return;
    this.announced = true;
    const { agent, build, restarted, post, log } = this.options;
    const text = `✅ ${agent}: ${restarted ? "Neustart abgeschlossen – wieder bereit." : "Gestartet und bereit."}\nSoftwarestand:\n${formatSoftwareVersions(build)}`;
    log(`[lifecycle] ${text}`);
    if (!target) return; // Never invent a recipient when no user channel is configured.
    post({ source: "host", sessionKey: "lifecycle:startup", text: "Runtime readiness notice", replyTo: target }, text);
  }
}
