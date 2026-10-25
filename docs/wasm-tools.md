# Restricted WebAssembly tools (experimental)

`wasmTools` is an infrastructure-owned, tool-only alternative to trusted ESM plugins:

```yaml
wasmTools:
  - name: plugin_transform
    description: Transform supplied text
    path: tools/transform.wasm
    timeoutMs: 5000
```

Paths resolve against Harness home. No module is downloaded or installed from
chat. Names must start with `plugin_`; ordinary tool selection, review guards and
approval configuration still apply. Restart to change registration/schema/config.
Module bytes are read per invocation: an in-flight worker retains its snapshot,
while the next invocation uses the replacement file. Publish files with atomic
rename; invalid bytes fail the invocation. No multi-plugin rollback is provided.

## ABI

The module must have **no imports**, including WASI. It exports:

- `memory`: linear WebAssembly memory;
- `alloc(length: i32) -> i32`: input buffer pointer;
- `run(pointer: i32, length: i32) -> i64`: output pointer in the high 32 bits,
  output byte length in the low 32 bits.

Input/output are UTF-8 strings, each at most 65536 bytes. The tool JSON schema is
`{ input: string }`. Modules are capped at 1 MiB. Fresh instances run in workers;
no environment, session history, credentials, filesystem, network or host callbacks
are passed to the module. Each call has a 1–30000 ms deadline (default 5000) and
honors cancellation by terminating its worker. There is no persistent module state.

## Security boundary and limits

This is a restricted capability surface, **not OS/process isolation**. The worker
runs trusted host glue inside the Harness process. WebAssembly imports are denied,
so guest code cannot directly use Node APIs. V8 defects and denial of service are
not ruled out. Worker heap limits do not cap WebAssembly linear memory or overall
process memory. Use container/process memory and CPU limits; do not run hostile,
unreviewed modules on the strength of this API alone. Files/configuration must be
provisioned through trusted infrastructure. Replacing a module is code deployment,
not a permission grant from chat.

Trusted ESM plugins retain their existing full privileges and startup lifecycle.
This interface does not hot-reload channels, providers or arbitrary JavaScript.
