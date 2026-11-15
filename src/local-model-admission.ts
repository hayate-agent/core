import type { Api, Model } from "@earendil-works/pi-ai";

/** Startup-owned concurrency only. No model/window/token/authority policy. */
export interface LocalModelScheduling {
  model: string;
  concurrency: number;
}
export type ModelAdmission = (model: Model<Api>, signal?: AbortSignal) => Promise<() => void>;

export function validateLocalModelScheduling(value: unknown): asserts value is LocalModelScheduling[] {
  if (!Array.isArray(value) || value.length > 32) throw Error("Invalid localModelScheduling");
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).some(key => !["model", "concurrency"].includes(key)) ||
        typeof row.model !== "string" || row.model.length > 256 || !/^[^/\s]+\/[^\s]+$/.test(row.model) || seen.has(row.model) ||
        !Number.isSafeInteger(row.concurrency) || row.concurrency < 1 || row.concurrency > 32) {
      throw Error("Invalid localModelScheduling");
    }
    seen.add(row.model);
  }
}

interface Waiter {
  interactive: boolean;
  grant(): void;
  cancel(): void;
}

/** One runtime owner, shared by its sessions/HTTP assessments/review worktrees.
 * Actual endpoint + physical model id, not provider aliases, identify capacity.
 * Running inference is never preempted; queued cancellation never calls a model.
 * Permits cover ONE model response, not tools or assessment of that response.
 */
export class LocalModelAdmission {
  private readonly lanes = new Map<string, { active: number; concurrency: number; foregroundBurst: number; queue: Waiter[] }>();

  acquire(key: string, concurrency: number, interactive: boolean, signal?: AbortSignal, waiting?: () => void): Promise<() => void> {
    signal?.throwIfAborted();
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { active: 0, concurrency, foregroundBurst: 0, queue: [] };
      this.lanes.set(key, lane);
    } else if (lane.concurrency !== concurrency) throw Error("Conflicting physical local model scheduling limits");
    const drain = () => {
      while (lane.active < lane.concurrency && lane.queue.length) {
        const foreground = lane.queue.findIndex(w => w.interactive);
        const background = lane.queue.findIndex(w => !w.interactive);
        // Prefer human responses without indefinitely starving already-owned work.
        const first = background >= 0 && lane.foregroundBurst >= 4 ? background
          : foreground >= 0 ? foreground : 0;
        const waiter = lane.queue.splice(first, 1)[0]!;
        lane.foregroundBurst = waiter.interactive && background >= 0 ? lane.foregroundBurst + 1 : 0;
        lane.active++;
        waiter.grant();
      }
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter: Waiter = {
        interactive,
        grant: () => {
          settled = true; signal?.removeEventListener("abort", waiter.cancel);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true; lane.active--; drain();
          });
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          const index = lane.queue.indexOf(waiter); if (index >= 0) lane.queue.splice(index, 1);
          signal?.removeEventListener("abort", waiter.cancel);
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          drain();
        },
      };
      signal?.addEventListener("abort", waiter.cancel, { once: true });
      lane.queue.push(waiter);
      if (signal?.aborted) waiter.cancel();
      else {
        drain();
        if (!settled) { try { waiting?.(); } catch { /* Telemetry cannot fail admission. */ } }
      }
    });
  }
}
