// SPDX-License-Identifier: Apache-2.0
import { createServer, type Socket } from "node:net";
import { mkdir, lstat, chmod, unlink } from "node:fs/promises";
import path from "node:path";
import type { PluginModule } from "./plugins.js";
import type { MaintenanceRequest } from "./context-maintenance.js";

export interface MaintenanceControl {
  status(): Promise<unknown>;
  admit(id: string, request: MaintenanceRequest, version: number): Promise<unknown>;
  cancel(id: string, version: number): Promise<void>;
  maintain(): Promise<unknown>;
}

/** Deliberate local same-UID write capability, separate from the observer endpoint. */
export function maintenanceControlPlugin(control: MaintenanceControl, directory: string): PluginModule {
  return { apiVersion: 1, async activate(api) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) throw Error("Unsafe maintenance directory");
    const endpoint = path.join(directory, "maintenance.sock"), clients = new Set<Socket>();
    let identity: Awaited<ReturnType<typeof lstat>> | undefined;
    let closed = false, ready = false, flight: Promise<unknown> | undefined;
    const requests = new Set<Promise<void>>();
    const timer = setInterval(() => {
      if (ready && !closed && !flight) {
        flight = control.maintain().catch(() => undefined).finally(() => { flight = undefined; });
      }
    }, 1000); timer.unref();
    const server = createServer(socket => {
      if (!ready || closed || clients.size >= 16 || requests.size >= 16) { socket.destroy(); return; }
      clients.add(socket); socket.setTimeout(5000, () => socket.destroy()); socket.setEncoding("utf8");
      socket.on("error", () => socket.destroy()); socket.on("close", () => clients.delete(socket));
      let buffer = "", submitted = false;
      socket.on("data", chunk => {
        if (closed || submitted || requests.size >= 16) { socket.destroy(); return; }
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 20000) { socket.destroy(); return; }
        const end = buffer.indexOf("\n"); if (end < 0) return;
        submitted = true;
        const request = (async () => {
          try {
            if (closed || buffer.slice(end + 1).length) throw Error("One request per connection");
            const frame = JSON.parse(buffer.slice(0, end));
            let result: unknown;
            if (frame.op === "status" && Object.keys(frame).length === 1) result = await control.status();
            else if (frame.op === "admit" && Object.keys(frame).every(k => ["op", "id", "version", "request"].includes(k)) &&
              typeof frame.id === "string" && Number.isSafeInteger(frame.version) && frame.version >= 0 && frame.request &&
              Object.keys(frame.request).every(k => ["action", "preserve", "resume"].includes(k))) result = await control.admit(frame.id, frame.request, frame.version);
            else if (frame.op === "cancel" && Object.keys(frame).length === 3 && Object.keys(frame).every(k => ["op", "id", "version"].includes(k)) && typeof frame.id === "string" && Number.isSafeInteger(frame.version) && frame.version >= 0) {
              await control.cancel(frame.id, frame.version); result = { cancelled: true };
            } else throw Error("Invalid request");
            if (!closed && !socket.destroyed) socket.end(JSON.stringify({ ok: true, result }) + "\n");
          } catch { if (!socket.destroyed) socket.end('{"ok":false,"error":"request rejected"}\n'); }
        })();
        requests.add(request); void request.finally(() => requests.delete(request));
      });
    });
    api.onStop(async () => {
      closed = true; clearInterval(timer);
      for (const socket of clients) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      await Promise.allSettled([...requests]);
      await flight;
      if (identity) {
        try { const current = await lstat(endpoint); if (current.dev === identity.dev && current.ino === identity.ino) await unlink(endpoint); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, () => { server.off("error", reject); resolve(); }); });
    server.on("error", () => { for (const socket of clients) socket.destroy(); });
    identity = await lstat(endpoint); await chmod(endpoint, 0o600);
    ready = true;
  } };
}
