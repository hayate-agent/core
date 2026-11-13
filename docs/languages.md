# Language policy — first implementation

Language preferences control presentation, not permissions, execution scopes, budgets,
model selection, tool names, identifiers or wire schemas. Technical prompts can remain
English. User-facing prose must not be copied from an English internal prompt merely
because that prompt was English.

## Installation and writable settings

`hayate-agent.yaml`, `settings.local.yaml` and normal `settings.d` layers accept:

```yaml
language:
  default: en                 # built-in default, also when the entire block is absent
  system: de                 # unsolicited lifecycle/system messages
  background: en             # optional; otherwise system, then default
  conversations:
    "matrix:!example:example.org": de
  jobs:
    "cron:weather": es
    "loop:matrix:!example:example.org": ru
  mcp:
    tickets: de
    search: en
```

Tags are validated/canonicalized BCP-47 (`en`, `de`, `es`, `ru`, `pt-BR`, etc.).
Map lookups are exact, bounded and own-property-only. Unknown configuration keys,
unsafe map names and instruction-like language values are rejected. Local writes
are serialized, durable and published only after save. Language settings are
live-reloadable; running model turns retain their existing per-turn instructions.
Normal installation/drop-in precedence still applies. `reset` removes the local
override, exposing installation/drop-in settings rather than deleting them.

## Resolution

- Conversation model replies: explicit task/conversation override; otherwise match
  the current operator's language, including switches; if unclear, `default`/`en`.
  Internal host-event wording must not switch a retained conversation's language.
- Unsolicited startup/restart notices: `system`, then `default`/`en`.
- Background jobs: exact job override, then `background`, `system`, `default`/`en`.
- Cron: writable `jobs["cron:<name>"]`, then job-file `language`, then background
  inheritance. Resolve once before executing the occurrence; retain the result in
  its inbox/anchor, not a reference that changes while a script or report is pending.
- MCP: exact configured server override, then background/system/default. These
  instructions reach tool-enabled runtime sessions, including worker sessions;
  they concern natural-language queries/content, not JSON keys or machine arguments.
  MCP replies are untrusted results, not automatic translations or language grants.

## Commands

```text
/language                         # status; non-admins see only their own resolved preference
/language default en
/language system de
/language background en
/language conversation ru
/language conversation reset
/language mcp tickets es
/language mcp tickets reset
/language job cron:weather de
/cron language weather es
/cron language weather reset
```

`/sprache` aliases `/language`. Writes require existing operator/admin privileges;
there is no model-writable language-setting tool. This is independent of automatic
matching of ordinary conversational language.

## Cron definition

```yaml
jobs:
  - name: weather
    schedule: "0 8 * * *"
    language: es
    prompt: "Report today's weather."
    deliver: origin
```

The language is presentation metadata, not follow-up authorization. No-agent jobs'
raw script output is not rewritten/translated and no extra model is invoked. Cron
reports retain the occurrence language for later analysis; summary/action prose uses
that language while JSON keys and disposition enums remain stable. Legacy reports
without language retain English analysis rather than acquiring a new mandate or
being rewritten during migration.

## Catalogs and plugins

`src/locales/{en,de,es,ru}.json` contains the migrated fixed lifecycle, language-control
and component-version messages. Catalog fallback is exact tag -> base tag -> English.
A supported BCP-47 tag does not imply every fixed message has a translation; currently
other catalog languages explicitly fall back to English. Model-produced natural
language is not restricted to these four catalog languages.

Core registers the read-only `language` service, version 1, before configured plugins:

- `resolve(scope)` returns the language for system/conversation/background/MCP.
- `render(catalogs, key, scope, values)` uses a plugin-owned keyed catalog, deterministic
  fallback and literal placeholder substitution. It never calls a model.

Plugins must use the host resolver instead of hardcoding their own agent default.
The cron adapter demonstrates optional service negotiation for pre-language hosts.
No MCP credentials or server transport configuration is moved into language settings.

## Deliberately unfinished / next migration steps

This is a foundation, not a claim that all output is localized:

1. Migrate remaining `/help`, administration, approval, context-maintenance, failure,
   Dispatcher attention/progress, MCP-management and channel/plugin UI strings to
   keyed catalogs. Keep protocol enums, stored diagnostic codes, log-only technical
   evidence and exact control tokens stable.
2. Add an authenticated, persisted conversation-language observation contract for
   deterministic **context-bound fixed messages**. Free-form replies already match
   language through model instructions; do not guess a language from host messages,
   URLs, code blocks or a neighbouring room. Existing legacy task anchors have no
   language provenance and must not be retroactively rewritten.
3. Propagate explicit job/conversation presentation language through all delegated
   work and cron-report follow-up mandates, independently of execution authority.
4. Expose resolved/requested/catalog-fallback information in configuration UI and
   extend translation coverage with catalog-key/placeholder parity tests.
5. Add cross-language end-to-end tests for language switching, restart, worker
   handoff and external MCP natural-language content. Only then activate broadly.

No installed agent settings or task ledgers are changed by this branch.

### MCP management slice

`/mcp` status, CRUD, immediate login/cancel responses, interactive manager,
help, known safe errors, and asynchronous OAuth notifications use the system
language captured at command start. Server-specific MCP language settings remain
for model tool content, not operator control messages. The global `/help` command
entry for MCP remains English. Protocol states, scope and exposure values, tool
names, command syntax, URLs and login IDs are not translated. Unexpected failures
remain redacted at the command boundary.
