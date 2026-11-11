import type { Harness } from "./harness.js";
import type { PluginModule } from "./plugins.js";
import type { SettingsService } from "./settings.js";
import { validateConversationPolicy, type ConversationPolicy } from "./gateway-settings.js";

/** Operator-only controls; input-user policy never grants administration. */
export function conversationPolicyPlugin(settings: SettingsService, harness: Harness): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerCommand({ name: "conversation-policy", admin: true,
      help: 'Per-gateway defaults/access: status [gateway] | defaults <gateway> <JSON rule> | channel <gateway> <target-ID> <JSON rule> | channels <gateway> <"*" or JSON ID array>',
      async run(args) {
        const match = args.trim().match(/^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/);
        const action = match?.[1] ?? "status", gateway = match?.[2], rest = match?.[3] ?? "";
        if (action === "status") return JSON.stringify(gateway
          ? settings.effective().gateways?.overrides?.[gateway]?.conversation ?? {}
          : settings.effective().gateways?.overrides ?? {});
        if (!gateway || !/^[a-z][a-z0-9_-]*$/.test(gateway) || harness.channels.get(gateway)?.conversationPolicy !== 1)
          throw Error("Active gateway does not support conversation policy");
        let policy: ConversationPolicy;
        try {
          if (action === "defaults") policy = { defaults: JSON.parse(rest) };
          else if (action === "channels") policy = { allowedChannels: JSON.parse(rest) };
          else if (action === "channel") {
            const parts = rest.match(/^(\S+)\s+([\s\S]+)$/);
            if (!parts) throw Error();
            policy = { channels: { [parts[1]]: JSON.parse(parts[2]) } };
          } else throw Error();
          validateConversationPolicy(policy);
        } catch { throw Error("Invalid conversation policy command/JSON"); }
        await settings.setGateways({ overrides: { [gateway]: { conversation: policy } } });
        harness.configureGateways(settings.effective().gateways ?? {});
        return `Conversation policy for ${gateway} saved and active for new inputs. Admin rights unchanged.`;
      },
    });
  } };
}
