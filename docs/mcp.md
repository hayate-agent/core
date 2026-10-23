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

New sessions read current configuration. Session disposal (including /new and
shutdown) emits session_shutdown before releasing the SDK session so MCP servers
can close. Connections belong to sessions, not a shared global pool. Stop methods
are best effort, not an isolation guarantee for malicious or stuck servers.

Automated acceptance covers local stdio initialize/discovery/tool execution,
opt-in disabled, empty tools, and child termination while the owner is alive.
Live authenticated HTTP/OAuth servers are not covered by that test and must be
validated with the target environment before deployment.
