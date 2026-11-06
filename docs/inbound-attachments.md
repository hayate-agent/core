# Durable inbound attachments v1

Optional channel attachment references use `{sessionKey, sha256, size, name}`.
The CLI configures `<home>/attachments`; files must already be durable at
`<root>/<SHA256(sessionKey)>/<sha256>` before the channel calls deliverInbound.
Core does not fetch remote URLs. GatewayFactoryContext advertises
`inboundAttachments: 1`; a gateway requiring this contract must reject an older
host rather than silently losing images. Existing text gateways remain unchanged.

Admission permits channel sources only, up to four files, 10 MiB each, 20 MiB
total. accept/submit validate metadata and bytes before acceptance; synchronous
enqueue validates metadata and revalidates bytes before runtime use. Restored
pending inputs recheck source, session ownership and file integrity. Invalid
attachments fail the turn, not a text-only fallback. Attachment-bearing inputs
are never merged into/steered through another turn's text-only path.

Files are opened no-follow and nonblocking, checked as regular files with exact
size, read with bounded buffers and verified by SHA-256. Parent directories and
local host processes remain trusted; this is not filesystem sandboxing. A session
cannot obtain another session's blob merely by copying its reference or changing
the owner field. File names are untrusted bounded metadata and never path inputs.

PNG/JPEG/GIF/WebP signatures yield actual image blocks in PromptOptions.images.
The PI adapter forwards these to SDK prompt options and explicitly rejects models
without image input. Signatures are not complete decoding or malware scanning.
Generic binaries are described by verified local file references, not silently
interpreted. Inbox state persists references only; image base64 is created just
before prompt and may subsequently occur in the runtime's normal conversation
storage according to its own retention rules.

The paired optional Slack plugin is developed in harness/plugins branch
feat/slack-socket-gateway; it depends on this Core contract. Core can be delivered
independently and has no Slack credentials or automatic activation. Install both
reviewed Slack modules from one immutable revision only after the Core is live.
No outbound attachment/send-file contract is implied by this inbound slice.

Operator retention must preserve pending attachments and referenced history;
automatic garbage collection is not implemented. Monitor persistent storage.
Tests use fake runtimes and transports, not live Slack or provider inference.
