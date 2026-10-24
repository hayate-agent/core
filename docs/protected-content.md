# Infrastructure-pinned content

`harness.yaml` can pin the SHA-256 of identity, voice, skills or other files:

```yaml
protectedContent:
  files:
    - path: SOUL.md
      sha256: <64 lowercase hexadecimal characters>
```

Paths resolve against Harness home. Pins are checked at startup, before every
working turn, before persona loading and before skill reload. A missing, unreadable
or changed file fails closed. No file contents are included in diagnostics.
`/protected-content status` is an admin-only inspection command supplied by the
bundled inspection plugin; it reports expected/actual hashes and paths.
Runtime-writable `settings.local.yaml` cannot override this manifest.

This is **integrity checking, not a sandbox or filesystem write protection**.
Deploy the manifest/config and protected files on infrastructure-owned read-only
mounts. A process with permission to change both files and manifest can defeat
pins after restart; trusted in-process ESM can bypass process checks. Checks also
do not eliminate a check/read race when an external writer can mutate a file.
Protect complete skill directories against injected unpinned files; enumerated
pins alone do not deny new skills. No hashes are enrolled automatically from a
potentially compromised current file, and no mutable overlay is silently promoted
to infrastructure policy. Infrastructure must publish the intended hashes.

The current surface covers file integrity and inspection. It does not implement
isolated untrusted plugins, immutable host policy, universal hot replacement or
restricted tool filesystem access. Empty configuration preserves existing behavior.
