# Conversation defaults, channel overrides and user admission

The shared `gateways.overrides.<gateway>.conversation` contract separates who may
address an agent from when/where the agent replies. Supported adapters declare
`conversationPolicy: 1`; explicitly configuring this policy on an unsupported
adapter fails closed instead of silently ignoring access restrictions.

```yaml
gateways:
  overrides:
    slack:
      conversation:
        allowedChannels: "*"
        defaults:
          users: "*"
          activation: threads
          replyLocation: thread
        channels:
          C_PRIVATE_OPERATOR:
            activation: open
            replyLocation: channel
          C_RESTRICTED:
            users: [U_OPERATOR_ID]
            activation: mentions
          C_SILENT:
            activation: disabled
```

Use native immutable channel/user IDs, not names. `"*"` means unrestricted by
this policy; an empty array denies all. `allowedChannels` applies to ingress,
destination discovery and explicit sends, never automatically joins channels or
grants provider permissions. An existing adapter allowlist also remains binding.
For an unrestricted personal agent, set both `allowedChannels` and
`defaults.users` to `"*"`. Other installations can set restrictive defaults and
selectively override `users` on individual channels. Unknown/new channels inherit
the defaults automatically. Ordinary users remain ordinary users: none of these
fields changes admin, approver, credential or deployment authority.

- `mentions`: each channel message needs a direct mention, including inside threads.
- `threads` (backward-compatible default): mention to engage, then human follow-ups
  in the engaged thread need no further mention. The bot's own posts engage threads too.
- `open`: normal human messages are considered without a mention. Unaddressed
  messages are `replyOptional`; the agent may return `NO_REPLY` rather than spam.
- `disabled`: no incoming model turns for that channel.
- `replyLocation: thread` (default): answer in the incoming/new thread.
- `replyLocation: channel`: answer at channel level with one stable channel
  conversation, not a fresh isolated session for each message.

DMs need no mention, but still enforce user/channel admission and `disabled`.
Own/bot messages and edits remain filtered for loop prevention. This policy
controls new input admission; already accepted work is not cancelled retroactively.
Previously created threads/conversations are preserved, not deleted by changes.

## Administration and persistence

An authenticated admin can update live policy through the native command:

```
/conversation-policy status slack
/conversation-policy defaults slack {"users":"*","activation":"threads","replyLocation":"thread"}
/conversation-policy channel slack C_PRIVATE_OPERATOR {"activation":"open","replyLocation":"channel"}
/conversation-policy channels slack "*"
```

These commands persist to local settings and apply to subsequent inputs. They do
not expose an agent-visible policy mutation tool. File edits in installation,
local settings or `settings.d` follow the ordinary settings activation/restart
lifecycle; editing a file alone is not proof a running adapter changed.

Policy maps merge by channel and field across installation/local/drop-in layers;
user/channel arrays replace instead of concatenating (an empty higher-layer list
must not accidentally re-enable inherited users). Higher-layer policy remains
binding after a lower-layer admin edit. Configure all named fields explicitly to
restore a previously overridden channel to its default behavior.
