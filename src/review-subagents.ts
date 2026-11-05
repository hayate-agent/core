import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";
import { isolatedReview, type ReviewExecutionRequest, type ReviewExecutionReceipt } from "./review-execution.js";
import type { AgentRuntime } from "./types.js";

/** Read-only child executions with durable provenance; never autonomous replay. */
export class ReviewSubagents {
  private closed = false;
  private startup?: Promise<void>;
  private initialize(): Promise<void> {
    return this.startup ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const file = path.join(this.directory, name);
        const record = JSON.parse(await readFile(file, "utf8"));
        if (record.version !== 1 || `${record.id}.json` !== name) throw Error("Invalid retained review child record");
        if (record.state === "running") {
          await writeFileDurable(file, JSON.stringify({ ...record, state: "interrupted", finishedAt: Date.now() }));
        }
      }
    })();
  }
  private active = new Map<string, { abort: AbortController; done: Promise<ReviewExecutionReceipt> }>();
  constructor(private readonly runtime: AgentRuntime, private readonly directory: string) {}
  review(request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt> {
    if (this.closed || request.signal?.aborted) return Promise.reject(Error("Review cancelled"));
    if (this.active.size >= 4) return Promise.reject(Error("Dedicated review subagent capacity reached"));
    const id = randomUUID(); const abort = new AbortController();
    const cancel = () => abort.abort();
    request.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 120000); timer.unref?.();
    const done = this.run(id, request, abort.signal).finally(() => {
      clearTimeout(timer); request.signal?.removeEventListener("abort", cancel); this.active.delete(id);
    });
    this.active.set(id, { abort, done });
    return done;
  }
  private async run(id: string, request: ReviewExecutionRequest, signal: AbortSignal): Promise<ReviewExecutionReceipt> {
    await this.initialize();
    if (signal.aborted || this.closed) throw Error("Review cancelled");
    const file = path.join(this.directory, `${id}.json`);
    const record = { version: 1, id, parent: request.sessionKey, fingerprint: request.fingerprint,
      sessionKey: `review-subagent:${id}`, model: request.model, thinking: request.thinking,
      createdAt: Date.now(), state: "running", tools: "disabled" };
    await writeFileDurable(file, JSON.stringify(record));
    try {
      const result = await isolatedReview(this.runtime, record.sessionKey, request, signal, id);
      await writeFileDurable(file, JSON.stringify({ ...record, state: "completed", finishedAt: Date.now(), result }));
      return { kind: "subagent", executionId: id, isolated: true, fingerprint: request.fingerprint, result };
    } catch (error) {
      await writeFileDurable(file, JSON.stringify({ ...record, state: signal.aborted ? "cancelled" : "failed", finishedAt: Date.now() }));
      throw error;
    }
  }
  async stop(): Promise<void> {
    this.closed = true;
    for (const child of this.active.values()) child.abort.abort();
    await Promise.allSettled([...this.active.values()].map(child => child.done));
  }
}
