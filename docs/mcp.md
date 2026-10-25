# MCP with the PI runtime

MCP is explicitly opt-in in harness.yaml:

```yaml
mcp:
  enabled: true
```

Both the local TUI and gateway use the same runtime adapter. Without this setting
no built-in MCP extension is installed. `tools: []` also skips MCP activation.
Trusted third-party plugins/extensions can independently open connections; this
setting is not a process sandbox or a network policy.

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
deferred exposure and per-tool overrides. See the bundled PI MCP documentation
for exact server/auth fields; do not place credentials in public Harness files.
The adapter installs MCP, codemode and tool-search extensions together. MCP tool
names are `mcp__<server>__<tool>` and use the runtime tool/approval pipeline.
Explicit Harness `tools` lists restrict active tools: include exact direct MCP
tool names or the codemode/tool_search entrypoints you intend to expose.
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
Project trust and explicit tool restrictions remain SDK-enforced.

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
This does not validate OAuth, remote TLS/proxies or any production server;
validate those in the target environment before deployment.

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
