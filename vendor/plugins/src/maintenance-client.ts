import { createConnection } from "node:net";
import { open } from "node:fs/promises";
import { constants } from "node:fs";

/** One explicit request; no retry after ambiguous disconnect or timeout. */
export async function maintenanceClient(args: string[], signal?: AbortSignal): Promise<string> {
  const [endpoint, op, id, versionText, file] = args;
  if (!endpoint || !["status", "admit", "cancel"].includes(op) ||
      (op === "status" ? args.length !== 2 : args.length !== (op === "admit" ? 5 : 4))) throw Error("Usage: maintenance <socket> status | admit <id> <version> <request.json> | cancel <id> <version>");
  let frame: Record<string, unknown> = { op };
  if (op !== "status") {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !/^\d+$/.test(versionText) || !Number.isSafeInteger(Number(versionText))) throw Error("Invalid request identity/version");
    frame = { op, id, version: Number(versionText) };
  }
  if (op === "admit") {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw Error("Request must be a regular file");
      const buffer = Buffer.alloc(20001);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > 20000) throw Error("Request file too large");
      const request = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!request || !["compact", "handover"].includes(request.action) || typeof request.preserve !== "string" || typeof request.resume !== "string" ||
          request.preserve.length + request.resume.length > 16000 || Object.keys(request).some(k => !["action", "preserve", "resume"].includes(k))) throw Error("Invalid maintenance payload");
      frame.request = request;
    } catch { throw Error("Invalid or oversized maintenance request file"); }
    finally { await handle.close(); }
  }
  const encoded = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(encoded) > 20000) throw Error("Request frame too large");
  if (signal?.aborted) throw Error("Maintenance request cancelled");
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(endpoint); let data = "", settled = false;
    const finish = (error?: Error, result?: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(Error("Maintenance request cancelled; reconcile status before retrying"));
    const timer = setTimeout(() => finish(Error("Maintenance response timed out; reconcile status before retrying")), 10000);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(encoded));
    socket.on("error", () => finish(Error("Maintenance connection failed; reconcile status before retrying")));
    socket.on("data", chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > 4096) finish(Error("Maintenance response too large"));
    });
    socket.on("end", () => {
      try {
        const response = JSON.parse(data);
        if (response?.ok !== true || !response.result || typeof response.result !== "object") throw Error();
        const r = response.result;
        // Render only typed allowlisted fields, never arbitrary server text/terminal escapes.
        if (op === "cancel") {
          if (r.cancelled !== true) throw Error();
          finish(undefined, JSON.stringify({ cancelled: true })); return;
        }
        if (!Number.isSafeInteger(r.version) || r.version < 0) throw Error();
        if (r.id !== undefined && (typeof r.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(r.id))) throw Error();
        if (op === "admit" && (r.state !== "accepted" || r.id !== id || r.version !== Number(versionText) + 1)) throw Error();
        if (r.execution !== undefined && !["pending", "applied", "failed", "superseded", "cancelled"].includes(r.execution)) throw Error();
        if (op === "status" && (r.version === 0
          ? r.id !== undefined || r.execution !== undefined
          : r.id === undefined || r.execution === undefined)) throw Error();
        finish(undefined, JSON.stringify({ version: r.version, ...(r.id ? { id: r.id } : {}), ...(op === "admit" ? { state: "accepted" } : {}), ...(r.execution ? { execution: r.execution } : {}) }));
      } catch { finish(Error("Maintenance response rejected or invalid; reconcile status before retrying")); }
    });
    socket.on("close", () => { if (!settled) finish(Error("Maintenance connection closed without a receipt; reconcile status before retrying")); });
  });
}
