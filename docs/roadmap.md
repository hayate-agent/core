# Delivery checklist

This tracks user requirements, not claims of implemented capabilities. All core
changes go through PRs. Existing agents must not be replaced by the new pilot.

## Coherent local agent (current priority)

- [x] Default TUI is a channel of the real Harness, not a separate PI agent loop.
- [x] Same core commands, persistence, goals, heartbeat, cron and queue in TUI/gateway.
- [x] Show identity, model, work, queue and background activity in a distinct layout.
- [ ] Verify goal/heartbeat/queue and recovery through the interactive path.
- [ ] Retain useful PI interaction: editing, tool progress, model/auth/session UI.
- [ ] Prove a real model-driven edit/test/build on the Harness's own checkout.

## Configurable integrations

- [x] Per-agent identity/persona, provider configuration and actual tool selection.
- [ ] Runtime-neutral stdio/HTTP MCP contracts, authentication and lifecycle.
- [ ] Install/manage pinned user-owned CLIs with a reconstructible tool manifest.
- [ ] OpenBao authentication and scoped secret access (skill presence is not access).
- [ ] Optional Bitwarden integration with an agent-owned identity/session.
- [ ] Own build/version area with tested activation and rollback for PI/Harness edits.

## Sessions and extensibility

- [x] Native plugin commands, channels, model tools, panels and interactive dialogs.
- [x] Opt-in PI-backed MCP stdio and authenticated local HTTP acceptance tests.
- [x] Session provider registration with bundled filesystem provider and legacy import.
- [x] Workspace-isolated local sessions and title-first resume selection.
- [ ] Segmented histories, indexed catalog, large-history benchmarks and idle eviction.
- [ ] Cross-provider migration/export and additional database providers.

## Dedicated deployment (private overlays)

- [ ] Havelock Vetinari standalone identity; no existing agent replacement.
- [ ] Matrix identity through Matrix Agent Dashboard and tested message delivery.
- [ ] Slack channel registration and delivery.
- [ ] GitOps image/config/secrets wiring and observed rollout.
- [ ] Clean up the superseded manual pilot only with data preservation considered.
- [ ] Assign platform-development team/projects later; no silent reassignment.

## Verification and maintenance

- [x] Exact direct npm versions and pinned Node LTS container base.
- [x] Public Apache-2.0 core and separate private deployment repository.
- [x] Protected main and major branches: PR required, including admins; zero approvals.
- [x] Native Linux/WSL and macOS packaging tests; PI-wrapper TUI startup/quit tests.
- [x] Unified Harness TUI Linux/macOS regression tests (not just prior wrapper tests).
- [ ] Full provider/channel integration and unattended background-operation tests.

A startup smoke test is not acceptance of the complete personal-agent product.
