# Fast semantic hashtags

Hashtags are presentation/retrieval metadata, never a mandate selector, permission, approval or tool-execution target. Explicit incoming hashtags and control commands already bypass semantic inference.

The baseline lives in the dedicated `src/topic-labels.ts` module. Classification is tool-free, thinking off, with a bounded metadata prompt rather than a full Main conversation/tool catalog. It uses exact configured model references in this order:

1. `modelRoles.roles.hashtag.model` (configure an actually available small local classifier).
2. `modelRoles.roles.dispatcher.model`.
3. The effective Main model.

Role configuration applies only when `modelRoles.enabled` is true. Missing/duplicate references are skipped; no guessed model names or heavy reviewer fallback. Each candidate gets at most two seconds; the three-model chain is bounded by six seconds, with cancellation. Invalid/unavailable results fall through. Exhaustion returns the explicit neutral `topic-clarification` label so tagging cannot stall the actual user turn for repeated 30-second retries. It never borrows another topic or asks the user to resend hashtags. This metadata fallback is not a completion/checker bypass.

Inputs are bounded independently: up to1600 incoming characters, up to4096 serialized candidate characters (exact IDs and full included bundles), and up to8 recent excerpts of240 characters. A bundle too large to display is omitted rather than silently inherited in full. The cache holds at most128 exact bounded metadata-context/model-chain results; it does not cache plugin results or execution authority.

## Plugin override (existing versioned service API)

A trusted plugin can replace generation without editing Harness or PI:

```js
export default {
  apiVersion: 1,
  activate(api) {
    api.registerService('topic-labeler', 1, {
      async label(text, candidates, recent, signal) {
        // Bounded inputs. Return semantic lowercase ASCII kebab-case tags.
        // Observe signal. Do not execute work or infer permission from metadata.
        return ['example-topic'];
      }
    });
  }
};
```

The override gets a two-second budget, bounded inputs and AbortSignal. A failed/invalid override falls through to the configured model chain, without exposing provider errors or granting tools. Service registration is unique under the normal trusted plugin lifecycle. Existing sessions consult the current service at each classification; in-flight calls keep their captured implementation. No sandbox, new network service or untrusted runtime plugin loading is introduced.
