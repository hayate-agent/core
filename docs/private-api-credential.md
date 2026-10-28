# Private loopback API credential

`API_SERVER_KEY` retains its existing behavior. Alternatively, explicitly set all:

```
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY_FILE=<absolute Harness home>/api-private/key
```

This opt-in mode is Linux/POSIX only. It cannot be combined with API_SERVER_KEY,
including an empty value. No arbitrary file path, hostname or wildcard bind is
accepted. No key is generated when the API is disabled. The CLI resolves the key
only after acquiring its exclusive home ownership lock and before runtime startup.
Do not call the resolver concurrently without that lock.

The actual Harness process generates 32 random bytes, writes a temporary file
0600 inside an owned 0700 directory, fsyncs, atomically renames, then fsyncs the
directory. Existing valid keys are reused, never rotated on restart. Missing key
means generate; malformed, permissive, symlinked, nonregular or hardlinked keys
fail startup. Existing unsafe directory permissions are rejected, not repaired.
An interrupted pre-rename write can leave a private orphan temporary file; it is
never used as a credential. Post-rename crashes leave a complete key. POSIX atomic
rename/fsync support on the assigned persistent filesystem is required.

The directory is created 0700 even under an inherited setgid home. Existing home
ancestors and the dedicated volume must be trusted: root and same-UID processes
can read/replace credentials and are in the trust boundary. This is not isolation
from tools running with the agent's UID, nor a sandbox against the operator.
Other agents must not mount this home. No Kubernetes, OpenBao or global policy
capability is granted. A private test client in that same assigned instance may
read the file directly and construct the Authorization header in memory; never
put the key in argv, env, Git, logs, test reports or chat. Do not expose a Service,
Ingress, hostPort, port-forward or external route for this acceptance listener.
Health remains unauthenticated by the existing protocol; API operations require
the bearer key. File content is not reloaded while running; controlled offline
rotation and restart is a separate operator action.

Delivery requires product review/release, then own-agent config review and GitOps
restart. Do not deliver the config to older images: they ignore KEY_FILE. Source
builds and local unit tests are not live acceptance or deployment proof.
