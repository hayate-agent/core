# WebUI onboarding candidate verification

Scope: first-use documentation, commented Core starter profile and non-overwriting
`init` output. Based on canonical Core main `cdacca2`; does not include the parallel
terminal-work-area, conversation-catalog or additional session-ownership changes.
WebUI execution, browser assets and HTTP lifecycle remain in the separate Plugins
candidate `feat/local-webui`; no Core gateway exemption or model-context constant.

Local candidate verification:

- Clean worktree dependency installation and normal plugin materialization.
- Typecheck and build passed.
- Entire TypeScript suite, bounded file concurrency 4: 1585 discovered,
  1584 passed, 1 existing skipped real Slack image-download fixture, 0 failures.
- Starter/config examples validated through the actual configuration contracts.
- `init` preserves existing files and does not activate optional transports.
- Cross-repository WebUI integration against this Core candidate passed (native
  GatewayManager/PluginHost/Harness, ingress deduplication, idle/busy update
  admission, lease fencing, same-ID retry and SSE shutdown).
- Diff whitespace checks passed.

The independent WebUI candidate passed 22 plugin tests, build and Chromium
presentation/security regressions. These are local checks, not remote CI or a
live model/Matrix/fleet acceptance. The npm install reported two moderate findings
in Core's existing dependency set; this candidate changes no dependencies.

Release order: publish/review the Plugins candidate, then Core onboarding. Both
require the normal canonical branch PR/CI workflow. No direct main push, remote
CI success, PR, merge or homelab promotion is implied by this file. The optional
WebUI is not included automatically in Core's existing image/materialization
catalog; fleet artifact packaging and explicit per-agent activation require their
own reviewed deployment step. Local-only HTTP must not be published to a LAN.
