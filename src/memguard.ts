import { readdir, readFile } from "node:fs/promises";

/**
 * Container memory guard.
 *
 * Kubernetes (cgroup v2, memory.oom.group=1) answers an OOM by killing the whole container,
 * the harness included. Then every running turn is lost and replays. Above `percent` of the
 * cgroup limit, the guard SIGKILLs the largest descendant process instead (e.g. a `tsc` started
 * by a tool). The tool call sees exit 137 and the turn goes on.
 * The working set is computed like the kubelet does: memory.current minus inactive_file.
 */
export interface MemoryGuardOptions {
  /** Threshold in percent of memory.max; 0 disables the guard. */
  percent: number;
  intervalMs?: number;
  cgroupDir?: string;
  procDir?: string;
  /** Only descendants of this pid are candidates (default: the harness itself). */
  root?: number;
  log?: (msg: string) => void;
  kill?: (pid: number) => void;
  /** Usage source (tests); default reads the cgroup. */
  usage?: () => Promise<MemoryUsage | undefined>;
}

export interface MemoryUsage {
  workingSet: number;
  limit: number;
}

export async function readUsage(cgroupDir = "/sys/fs/cgroup"): Promise<MemoryUsage | undefined> {
  try {
    const [max, current, stat] = await Promise.all(
      ["memory.max", "memory.current", "memory.stat"].map((f) => readFile(`${cgroupDir}/${f}`, "utf8")),
    );
    const limit = Number(max!.trim());
    if (!Number.isFinite(limit) || limit <= 0) return undefined; // "max": no limit
    const inactive = Number(/^inactive_file (\d+)$/m.exec(stat!)?.[1] ?? 0);
    return { workingSet: Math.max(0, Number(current!.trim()) - inactive), limit };
  } catch {
    return undefined; // not Linux / no cgroup v2
  }
}

interface ProcInfo {
  pid: number;
  ppid: number;
  /** Start time in clock ticks since boot (field 22 of stat): identifies the process across pid reuse. */
  start: string;
  rss: number;
  /** Executable name (/proc/<pid>/comm); never the arguments, which may carry secrets. */
  comm: string;
}

async function readProc(procDir: string, pid: number): Promise<ProcInfo | undefined> {
  try {
    const [stat, statm] = await Promise.all([readFile(`${procDir}/${pid}/stat`, "utf8"), readFile(`${procDir}/${pid}/statm`, "utf8")]);
    // "pid (comm) state ppid ...": comm may contain spaces and parentheses.
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const fields = stat.slice(close + 2).split(" "); // fields[0] is field 3 (state)
    return { pid, ppid: Number(fields[1]), start: fields[19] ?? "", rss: Number(statm.split(" ")[1]) * 4096, comm };
  } catch {
    return undefined; // exited meanwhile
  }
}

/** Largest descendant of `root` by RSS: only processes this harness started (tool calls). */
export async function largestChild(procDir = "/proc", root = process.pid): Promise<ProcInfo | undefined> {
  const procs = new Map<number, ProcInfo>();
  for (const name of await readdir(procDir).catch(() => [] as string[])) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const info = await readProc(procDir, pid);
    if (info) procs.set(pid, info);
  }
  const isDescendant = (p: ProcInfo) => {
    const seen = new Set<number>();
    for (let cur = procs.get(p.ppid); cur && !seen.has(cur.pid); cur = procs.get(cur.ppid)) {
      if (cur.pid === root) return true;
      seen.add(cur.pid);
    }
    return p.ppid === root;
  };
  let best: ProcInfo | undefined;
  for (const p of procs.values()) if (p.pid !== root && isDescendant(p) && (!best || p.rss > best.rss)) best = p;
  return best;
}

export function startMemoryGuard(opts: MemoryGuardOptions): () => void {
  if (!(opts.percent > 0)) return () => undefined;
  const log = opts.log ?? ((m: string) => console.error(`[memguard] ${m}`));
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  let busy = false;
  let stopped = false;
  const check = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const pressure = async () => {
        const u = await (opts.usage ?? (() => readUsage(opts.cgroupDir)))();
        return u && u.workingSet * 100 >= u.limit * opts.percent ? u : undefined;
      };
      if (!(await pressure()) || stopped) return;
      const victim = await largestChild(opts.procDir, opts.root);
      if (stopped || !victim) return;
      // Re-check right before the signal: still under pressure, same process (start time
      // guards against pid reuse; the remaining window is a few microseconds).
      const usage = await pressure();
      if (stopped || !usage) return;
      const now = await readProc(opts.procDir ?? "/proc", victim.pid);
      if (stopped || !now || now.start !== victim.start || now.ppid !== victim.ppid) return;
      const mb = (n: number) => `${Math.round(n / 2 ** 20)}Mi`;
      log(`working set ${mb(usage.workingSet)} of ${mb(usage.limit)}: killing pid ${victim.pid} ${victim.comm} (${mb(victim.rss)})`);
      try {
        if (!stopped) kill(victim.pid);
      } catch (err) {
        log(`kill ${victim.pid} failed: ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void check(), opts.intervalMs ?? 1000);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
