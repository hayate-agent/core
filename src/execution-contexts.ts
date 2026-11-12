import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";

export interface ExecutionContext { cwd: string; directories: string[] }
/** Host-owned immutable stream contexts. Never use process.chdir in a concurrent agent. */
export class ExecutionContexts {
  private bindings: Record<string, ExecutionContext> = Object.create(null);
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string, private readonly fallback: string,
    private readonly parent: (key: string) => string | undefined = () => undefined) {}
  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data.version !== 1 || !data.bindings || typeof data.bindings !== "object" || Array.isArray(data.bindings)) throw Error("Invalid execution context store");
      for (const [key, value] of Object.entries(data.bindings)) {
        if (!key || !this.valid(value)) throw Error("Invalid persisted execution context");
      }
      this.bindings = Object.assign(Object.create(null), data.bindings);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private valid(value: unknown): value is ExecutionContext {
    const context = value as ExecutionContext;
    return !!context && typeof context.cwd === "string" && path.isAbsolute(context.cwd) && Array.isArray(context.directories) && context.directories.includes(context.cwd) && context.directories.every(p => typeof p === "string" && path.isAbsolute(p));
  }
  get(key: string): ExecutionContext {
    const visited = new Set<string>();
    for (let current: string | undefined = key; current; current = this.parent(current)) {
      if (visited.has(current)) throw Error("Cyclic execution context ownership");
      visited.add(current);
      if (Object.hasOwn(this.bindings, current)) return structuredClone(this.bindings[current]!);
    }
    return { cwd: this.fallback, directories: [this.fallback] };
  }
  /** Snapshot inherited ancestry once; existing histories remain locatable even
   * when a checkout is temporarily unavailable. Opening tools can then fail per
   * session rather than preventing the entire agent from starting. */
  async capture(key: string): Promise<ExecutionContext> {
    if (Object.hasOwn(this.bindings, key)) return structuredClone(this.bindings[key]!);
    return this.bind(key, this.get(key));
  }
  bind(key: string, value: { cwd: string; directories?: string[] }): Promise<ExecutionContext> {
    const work = this.serial.then(async () => {
      if (!key || typeof key !== "string" || typeof value?.cwd !== "string" || !path.isAbsolute(value.cwd) ||
          (value.directories !== undefined && (!Array.isArray(value.directories) || value.directories.some(p => typeof p !== "string" || !path.isAbsolute(p))))) throw Error("Absolute execution directories required");
      const directories = [...new Set(await Promise.all([value.cwd, ...(value.directories ?? [])].map(p => realpath(p))))];
      for (const directory of directories) if (!(await stat(directory)).isDirectory()) throw Error("Execution context must be a directory");
      const next = { cwd: directories[0]!, directories };
      if (Object.hasOwn(this.bindings, key)) {
        if (JSON.stringify(this.bindings[key]) !== JSON.stringify(next)) throw Error("A stream's execution context is immutable; create a new stream to change directories");
        return structuredClone(next);
      }
      const bindings = Object.assign(Object.create(null), this.bindings, { [key]: next });
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFileDurable(this.file, JSON.stringify({ version: 1, bindings }));
      this.bindings = bindings;
      return structuredClone(next);
    });
    this.serial = work.catch(() => {});
    return work;
  }
  async drain(): Promise<void> { await this.serial; }
}
