import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LoadedMcpConfig, McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";

export interface McpConnection {
  state: string;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  oauthUrl?: string;
  challenge?: unknown;
  oauthSettings(): Record<string, unknown>;
  getClient(): Promise<unknown>;
  reconnect(): Promise<void>;
  signOut(): Promise<void>;
  close(): Promise<void>;
}
export interface McpCredentials {
  forServer(name: string, url: string): unknown;
  tokens(name: string, url: string): unknown;
  remove(name: string, url: string): boolean;
}
export interface McpManagementAdapter {
  load(agentDir: string, cwd: string, trusted: boolean): LoadedMcpConfig;
  validate(name: string, config: unknown): McpServerConfig | string;
  credentials(agentDir: string): McpCredentials;
  connect(entry: McpServerEntry, cwd: string, credentials: McpCredentials, providerToken?: (provider: string) => Promise<string | undefined>): McpConnection;
  login(options: { serverUrl: string; store: unknown; settings: Record<string, unknown>; challenge?: unknown;
    prompt: { showAuthorizationUrl(url: URL): void; promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> };
    signal: AbortSignal }): Promise<void>;
}

/**
 * Single compatibility boundary for the pinned PI 1.4.0 MCP implementation.
 * PI does not export these management primitives from its package root yet.
 * Reuse its OAuth/PKCE, refresh locks and credential format rather than inventing
 * a second authentication implementation. No shell, subprocess or model turn.
 */
export async function piMcpManagementAdapter(): Promise<McpManagementAdapter> {
  const root = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const load = (name: string) => import(pathToFileURL(path.join(root, name)).href);
  const [config, runtime, servers, storage] = await Promise.all([
    load("extensions/mcp/config.js"), load("extensions/mcp/runtime.js"),
    load("core/mcp-servers.js"), load("core/auth-storage.js"),
  ]);
  for (const fn of [config.loadMcpConfig, servers.validateMcpServerConfig, runtime.McpServerConnection,
    runtime.McpOAuthCredentialStore, runtime.signInMcpServer, storage.FileAuthStorageBackend]) {
    if (typeof fn !== "function") throw Error("Installed PI MCP management adapter is incompatible");
  }
  return {
    load: (agentDir, cwd, projectTrusted) => config.loadMcpConfig({ agentDir, cwd, projectTrusted }),
    validate: servers.validateMcpServerConfig,
    credentials: agentDir => new runtime.McpOAuthCredentialStore(new storage.FileAuthStorageBackend(path.join(agentDir, "mcp-auth.json")), agentDir),
    connect: (entry, cwd, credentials, providerToken) => new runtime.McpServerConnection({ entry, cwd, credentials, providerToken,
      createTransport: runtime.createDefaultTransport, onTools() {} }),
    login: runtime.signInMcpServer,
  };
}
