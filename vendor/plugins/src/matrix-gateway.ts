import { MatrixChannel, matrixOptionsFromEnv } from "./matrix-channel.js";
import type { GatewayModule } from "./gateway-provider.js";
const plugin: GatewayModule = {
  apiVersion: 1,
  async create(context) {
    const options = matrixOptionsFromEnv(process.env, context.home);
    if (!options) return undefined;
    const approvers = context.approvers.length ? context.approvers : options.approvers?.length ? options.approvers : context.admins ?? [];
    const channel = new MatrixChannel({ ...options, approvers, displayName: options.displayName ?? context.agent });
    return { channel, home: channel.home, approvers: options.approvers ?? [] };
  },
};
export default plugin;
