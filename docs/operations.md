# Operations

## Tool approvals and YOLO

`/yolo on|off|status` controls the Harness's manual tool approvals, not a PI
runtime mode. With no argument it reports status; it never implicitly toggles.
`on` disables manual tool approvals, `off` enables them, and repeated settings
are idempotent. This does not extend permissions or bypass review requirements.
The command requires administrator access, including status queries.

`/approvals off|manual [tool...]` configures the same state and optionally limits
which tools require approval. `/yolo` preserves that tool selection. Consequently,
`/yolo off` enables approvals for the configured selection (all tools when empty).

`/help` (alias `/commands`) lists Harness commands separately from registered
plugin commands, marks administrative commands with `[admin]`, and explains the
YOLO scope. Migration: scripts relying on bare `/yolo` toggling must use explicit
`/yolo on` or `/yolo off` instead.

## Memory pressure

On cgroup v2 with `memory.oom.group=1`, an OOM can kill the entire container,
including the harness. This is not universal Kubernetes behavior: it depends on
cgroup and kubelet configuration.

The memory guard is best-effort, not a guarantee against OOM. With a finite cgroup
v2 `memory.max`, it polls once per second. At or above `memoryGuard.percent`
(default 90), using `memory.current - inactive_file` as the working-set estimate,
it selects the largest-RSS descendant of the harness and sends SIGKILL after
rechecking pressure and process identity. The foreground tool will typically
report exit 137; the harness can continue without restarting.

Limits: fast allocation can outrun polling; the harness itself can exhaust memory;
orphaned/reparented processes are not descendants and are not selected. This is
not process isolation or a replacement for workload resource sizing. The current
RSS calculation assumes 4 KiB pages. On other page sizes victim ordering is
unchanged, but logged RSS is inaccurate. Outside supported cgroup v2 layouts the
guard is inactive. Commands are not logged, only process names, PIDs and sizes.

## Interrupted turns

A replayable turn's start is checkpointed before execution. If the checkpoint
fails, the input stays queued and the scheduler retries after storage recovers.
Only an input marked as running when the process died consumes its crash budget;
queued inputs do not. Three crash replays are allowed, then another interruption
causes a failed reply instead of an unbounded crash loop. Graceful shutdown clears
the running marker so an interrupted drain does not consume the budget.

Replay is at-least-once, not exactly-once. Tool side effects may already have
happened before an interruption; check state before retrying destructive operations.

## Shutdown and console

SIGTERM stops intake, drains for `loop.drainSeconds` (default 60), then retains
unfinished inputs for restart. `/restart` exits with status 75. Give the supervisor
more shutdown time than the drain budget (the supplied examples use 90 seconds).

The console channel attaches when stdin is a TTY, `--console` is set, or no other
channel is configured. Headless API/Matrix services therefore do not read stdin.

## Dependency updates

Direct npm dependencies are exact versions and `package-lock.json` pins the tree.
Use `npm ci` for installation. The container defaults to Node 24 LTS pinned by tag
and multi-platform digest. Native installation supports Node >=22.19.0; `.node-version`
records the recommended version. OS packages installed by apt are not version-pinned;
full image reproduction requires a package snapshot or a prebuilt published digest.

Update versions and the lockfile in a PR, then run typecheck, tests, audit and
native/container smoke tests. A newer major Node release is not automatically a
better production default than the current supported LTS line.
