# MCP with the PI runtime

## Native user management

Type **`/mcp` in Hayate**, not in a separate PI console. In the local TUI this
opens a server/action picker and an HTTP/stdio add wizard. In Matrix and WebUI
it shows server status and the available subcommands. These are host-side user
commands: no agent/model turn or shell command is involved.

```text
/mcp add docs https://example.com/mcp
/mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /workspace
/mcp status
/mcp tools docs
/mcp login docs
/mcp logout docs
/mcp connect docs
/mcp disconnect docs
/mcp exposure docs direct
/mcp remove docs
/mcp help
```

`add` saves a new server; `edit <name> <JSON>` replaces an existing definition.
Advanced definitions accept the same JSON as PI (environment/header references,
OAuth client settings, descriptions and per-tool exposure). Quoted stdio arguments
are split without shell evaluation or environment expansion. Unrelated entries
are preserved; writes are atomic and owner-only. The effective defining file is
used for edits, including an already trusted project override. New entries are
user-level; the manager does not grant project trust implicitly.

Management uses the existing Hayate administrator identities. The local console
is privileged. Matrix/WebUI actors must be enrolled in `admins` (for example the
existing authenticated `webui:local` actor); ordinary API run text is **not** a
privileged user command. This does not add an independent review/approval gate.

### OAuth sign-in

`/mcp login <name>` starts sign-in and returns immediately. The authorization link
and final outcome are delivered to the same conversation. Approve access in your
browser. If its loopback callback reaches the agent, sign-in completes directly.
For a remote agent, copy the browser's final loopback redirect URL and send
it with the configured MCP server name (no need to copy a separate login ID):

```text
/mcp auth <server-name> <redirect-url>
/mcp cancel <server-name>
```

The login ID remains accepted instead of the server name for compatibility.
Names resolve only pending sign-ins owned by this actor and conversation; they
never select another user's sign-in. An ambiguous name requires the login ID.
Only the original authenticated actor **and conversation** can finish/cancel that
login. PI performs OAuth discovery, PKCE/state/issuer validation, token exchange
and refresh; Hayate does not create a competing token store. Access/refresh tokens
stay in the agent's private `mcp-auth.json`; they are never returned in command
results. The redirect contains a short-lived authorization code: use the original
private conversation, never paste access/refresh tokens. Authentication lasts at
most five minutes; cancellation/shutdown closes pending work. Restart interrupts
a pending dialog; start a new sign-in. Completed credentials survive restart.
Logout clears the stored local OAuth credentials, not the provider's external grant.

### Activation and scope

Adding or connecting an enabled server explicitly enables MCP for this Hayate
instance and saves that choice in `settings.local.yaml`. `/mcp enable` and
`/mcp disable` control the runtime; `/mcp enable|disable <name>` controls one server.
Existing session connections reload at their **next prompt boundary**, preserving
history and in-flight work. A management status/tools request probes the server
and closes that probe connection; it is not a claim about every conversation's
separate transport. Changes do not require an agent restart.

Installation configuration can still set the initial value:

```yaml
mcp:
  enabled: true
```

Without configuration or an explicit user management action, no built-in MCP
extension is installed. `tools: []` also skips model MCP activation; management
remains available. The native user manager reserves MCP/codemode/tool-search entrypoints so a
server you connect is usable without manually editing the starter tool list.
Explicit `mcp__...` tool/namespace patterns still restrict MCP tools; `tools: []`
still exposes none. Unrelated non-MCP tools are not added to the allowlist. Trusted third-party
plugins/extensions can independently open connections; this setting is not a
process sandbox or network policy.

Server definitions and credentials stay outside product code. The PI adapter reads
its normal user configuration (`~/.pi/agent/mcp.json`, or mcp.json under
PI_CODING_AGENT_DIR). Project `.pi/mcp.json` requires PI project trust. Review
project trust before enabling code execution. This is currently a PI-backed MCP
implementation, not an independent Harness transport implementation.

Example user mcp.json:

```json
{
  "mcpServers": {
    "example": {
      "command": "/absolute/path/to/server",
      "args": [],
      "exposure": "direct"
    }
  }
}
```

The SDK supports stdio and streamable HTTP, authentication, direct/codemode/
deferred exposure and per-tool overrides. `/mcp add|edit` accepts these fields;
see the bundled PI MCP documentation for advanced field definitions. Do not place
credentials in public Harness files.
The adapter installs MCP, codemode and tool-search extensions together. MCP tool
names are `mcp__<server>__<tool>` and use the runtime tool/approval pipeline.
Native CLI user management exposes configured MCP tools through their selected
exposure and retains explicit `mcp__...` patterns. SDK embedders that do not enable
the user-management integration retain their original explicit tool selection.
Discovery can finish asynchronously; only direct-tool readiness gates prompts.

New sessions read current configuration. `/reload-mcp` (an alias of
`/reload-skills`) schedules SDK session-resource reload at each existing session's
next prompt boundary. It does not interrupt a running turn. MCP-enabled sessions
also compare user/project `mcp.json` content before each prompt and reload when it
changes, including additions and removals. This is turn-boundary discovery, not a
background watcher; environment-only credential changes are not detected.
Invalid JSON blocks that prompt before closing the previous connections. Other
SDK reload/start failures are not transactional rollback; repair configuration and
retry. File validation is syntax-only and cannot eliminate external write races.
The adapter passes the persisted PI project-trust decision to both the SDK
resource loader and session settings. Projects without an explicit stored allow
decision do not load project-local executable resources; user-level configuration
remains available. Automatic discovery ignores untrusted project `mcp.json`.
Grant trust externally through PI's project-trust controls; chat cannot grant it.
Explicit tool restrictions remain SDK-enforced.

SDK resource reload also re-reads trusted runtime extensions/settings, not only
MCP. It does not reload Harness general plugins or configuration, and is not an
isolation boundary. Conversation history/session manager is retained. Session
disposal (including /new and shutdown) emits session_shutdown before releasing
the SDK session so MCP servers can close. Connections belong to sessions, not a shared global pool. Stop methods
are best effort, not an isolation guarantee for malicious or stuck servers.

Automated acceptance covers local stdio initialize/discovery/tool execution,
opt-in disabled, empty tools, and child termination while the owner is alive.
A local Streamable HTTP integration test additionally covers authentication using an environment-referenced Bearer token, tool execution, session-ID continuity, DELETE on
shutdown and denial of an invalid bearer without tool execution. Its credential
is randomly generated per test and checked against child-process output.
User-management acceptance also covers real local HTTP OAuth metadata discovery,
PKCE token exchange, remote pasted and direct browser callbacks, actor isolation,
cancel, credential persistence and logout, native TUI wizard, and the actual
WebUI HTTP-to-Harness command path. It does not claim acceptance against a specific
production OAuth provider or every reverse-proxy/TLS configuration.

The SDK's management primitives are not exported at its root in pinned PI 1.4.0.
`runtime/pi-mcp-management.ts` is the single isolated compatibility binding to
those installed modules. Dependency upgrades must pass these real integration
tests; no CLI subprocess is used to manage or authenticate servers.

Example HTTP server entry in the external mcp.json:

```json
{
  "mcpServers": {
    "example-http": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "<REDACTED_AUTHORIZATION_HEADER>" },
      "exposure": "direct"
    }
  }
}
```

Replace the redacted header with the Bearer scheme followed by an environment
reference such as `${EXAMPLE_MCP_TOKEN}`. Provide the token through the process
environment using your secret-management system. Do not commit it in mcp.json or include it in diagnostic output.
