import type { Dispatcher } from "./dispatcher.js";
import type { PluginModule } from "./plugins.js";

/** Operator-only decision on a dispatcher swarm proposal. Not a model tool:
 * Main and workers cannot accept, correct or reject a swarm. */
export function dispatchSwarmPlugin(get: () => Dispatcher | undefined): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerCommand({ name: "swarm", admin: true,
      help: "Answer a dispatcher swarm proposal: /swarm <executionId> <vN> ja | nein | <correction>",
      async run(args, context) {
        const dispatcher = get();
        if (!dispatcher) throw Error("Dispatcher mode is not active");
        if (/^(dispatch|subagent):/.test(context.sessionKey)) throw Error("Swarm decisions belong to the operator conversation");
        // Authenticated operator ingress only; never relayed host/model input.
        if (context.operatorAuthorized !== true || context.source !== "channel") return "⛔ authenticated operator only";
        const match = args.trim().match(/^(\S+)\s+(v\d{1,3})\s+([\s\S]+)$/);
        if (!match) {
          const pending = dispatcher.store.list(context.sessionKey).filter(row => row.question?.swarm && row.question.answer === undefined && row.status === "paused");
          if (args.trim()) return "Format: /swarm <id> <vN> ja | nein | <Korrektur> (vN steht im Vorschlag)";
          return pending.length ? pending.map(row => `${row.id}: ${row.question!.text.split("\n")[0]}`).join("\n") + "\n/swarm <id> <vN> ja | nein | <Korrektur>" : "Kein offener Schwarm-Vorschlag.";
        }
        const answer = match[3]!.trim();
        if (answer.length > 8000) throw Error("Answer too long");
        await dispatcher.answerSwarm(context.sessionKey, match[1]!, match[2]!, answer);
        return "Schwarm-Entscheidung gespeichert.";
      },
    });
  } };
}
