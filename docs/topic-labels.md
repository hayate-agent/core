# Fast semantic hashtags

Hashtags are presentation/retrieval metadata, never a mandate selector, permission,
approval or tool-execution target. Explicit incoming hashtags and control commands
bypass semantic inference.

## Model and provider settings

```yaml
model: example-provider/main-model
hashtag:
  model: example-provider/small-classifier  # optional; otherwise effective Main
  provider: default                       # optional: default, tags-only, or a service suffix
```

`hashtag.model` is the single metadata model override. When absent, classification
uses the effective instance Main model (`model`), **not** the current conversation's
model, reviewer, dispatcher or a role chain. If Main is also unset, the runtime's
configured default resolves it. Model references must be full `provider/model`
identifiers; use the configured runtime catalog rather than inventing a model name.
An explicit unavailable model produces neutral metadata, not a silent switch to
another model.

Installation defaults belong in `hayate-agent.yaml`; the same `hashtag` object is
accepted in `settings.local.yaml` and `settings.d/*.yaml` layers. The models menu
and administrator command `/hashtag-model provider/model` persist a local override.
`/hashtag-model reset` removes that override and inherits the lower layer (an
installation `hashtag.model`, if present, otherwise Main). Model overlay edits and
reset apply at the next classification; active inference is not retargeted.
`hashtag.provider` and trusted plugin modules are startup-bound: reload records a
changed provider as restart-pending, while the active provider stays unchanged.
Restart activates it. There is no general ESM hot reload.

**Migration:** `modelRoles.roles.hashtag` remains parseable for old installations,
but no longer selects classification. Move its model to `hashtag.model`, or remove
it to inherit Main. `modelRoles.enabled`, dispatcher and reviewer settings do not
change this rule. Hashtag thinking is always `off`, not inherited from those roles.

The CLI uses one startup factory and the normal plugin service registry for both
default and selected providers. Default classification is tool-free and ephemeral,
with the metadata-specific assessment purpose; PI disables tools, extensions,
context files, skills, prompt templates and working-agent persona. It receives a
bounded metadata prompt, not the full Main conversation/tool catalog. Serialized
input data is bounded to 3000 characters; included candidate ids and complete
umbrella bundles must fit. An oversized bundle is omitted, never inherited unseen.
The in-memory cache holds at most 128 exact bounded-context/model results; plugin
results and execution authority are not cached.

The default model attempt has a two-second budget with cancellation. Failure or an
invalid response yields `topic-clarification`, so the real user turn can proceed
without requesting a resend. This neutral label is not a completion/checker bypass.
The semantic protocol selects an included candidate id and explicitly opts into
umbrella inheritance; unrelated/interleaved topics stay independent and candidates
are scoped to the Harness conversation.

## Trusted plugin service (API version 1)

The default provider first consults the legacy `topic-labeler` version-1 service:

```js
export default {
  apiVersion: 1,
  activate(api) {
    api.registerService('topic-labeler', 1, {
      async label(text, candidates, recent, signal) {
        // Bounded inputs; observe AbortSignal. Return lowercase ASCII kebab-case tags.
        // Do not execute work or infer permission from metadata.
        return ['example-topic'];
      }
    });
  }
};
```

For `hashtag.provider: custom`, register `topic-labeler-custom` version 1 with the
same signature. Load the trusted ESM module through normal `plugins` configuration
(see [plugins](plugins.md)). A valid custom response is used directly, with **no**
default model inference. An explicitly selected missing/failing/invalid service
returns neutral metadata and does not switch to default inference. Only the legacy
`default` override may fall back to the configured metadata model when it fails;
that path can consume two successive two-second attempts. Plugin registration is
unique, trusted process-user JavaScript, not a sandbox or a new provider registry.

## Optional tags-only protocol

`hashtag.provider: tags-only` selects the bundled `topic-labeler-tags-only` service.
It uses the same model selection, service dispatch, metadata purpose, thinking-off
setting and deadline, but asks the model for a JSON array such as
`["database-repair","retry"]`. The response may also be a single complete
triple-backtick code block with an optional `json` language label. Prose outside
the block, partial or multiple blocks, and other language labels are rejected;
the entire JSON body must still contain 1–3 valid lowercase ASCII kebab-case tags
of at most 48 characters. This protocol returns independently relevant tags.
It **does not promise candidate selection or umbrella-tag inheritance**, and is
not semantically equivalent to the default `{topic, inherit, tags}` protocol.
Use `default` when preserving a selected candidate's umbrella tags is required.

Synthetic regression coverage in `test/hashtag-startup.test.ts` loads normal YAML,
SettingsService and PluginHost through the production startup factory, then drives
real Harness ingress. It verifies model/reset/restart selection, trusted services,
session isolation, tags-only limits and held-runtime abort/dispose. The model
runtime is synthetic: these tests are not evidence of live provider authentication,
SDK/network inference, installation or activation.
