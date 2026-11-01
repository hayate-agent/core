import { createServer, createConnection, type Socket } from "node:net";
import { mkdir, lstat, chmod, unlink } from "node:fs/promises";
import path from "node:path";
import type { PluginModule } from "./plugins.js";
import { observeSessionChanges, type SessionObserver } from "./session-observer.js";

/** Trusted composition supplies one exact conversation, never arbitrary client-selected scope. */
export function sessionObserverPlugin(owner: SessionObserver, directory: string, key: string): PluginModule {
  return { apiVersion: 1, async activate(api) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const dir = await lstat(directory);
    if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || dir.uid !== process.getuid?.()) throw Error("Unsafe observer directory");
    const endpoint = path.join(directory, "observe.sock");
    const clients = new Set<Socket>();
    const controllers = new Set<AbortController>();
    let identity: Awaited<ReturnType<typeof lstat>> | undefined;
    const server = createServer(socket => {
      if (clients.size >= 16) { socket.destroy(); return; }
      clients.add(socket);
      const controller = new AbortController(); controllers.add(controller);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => { controller.abort(); controllers.delete(controller); clients.delete(socket); });
      // Read-only protocol: any client input is invalid, including forged identities/commands.
      socket.on("data", () => socket.destroy());
      void (async () => {
        try {
          for await (const status of observeSessionChanges(owner, key, controller.signal)) {
            if (socket.destroyed) break;
            // Bounded transport: disconnect a slow client instead of accumulating a backlog.
            if (!socket.write(JSON.stringify({ type: "status", status: status ?? null }) + "\n")) {
              socket.destroy(); break;
            }
          }
        } catch { socket.destroy(); }
      })();
    });
    const stop = async () => {
      for (const controller of controllers) controller.abort();
      for (const socket of clients) socket.destroy();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (identity) {
        try {
          const current = await lstat(endpoint);
          if (current.dev === identity.dev && current.ino === identity.ino) await unlink(endpoint);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      // Keep the private directory: operators remove it after confirming owner shutdown.
    };
    api.onStop(stop);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => { server.off("error", reject); resolve(); });
    });
    server.on("error", () => { for (const socket of clients) socket.destroy(); });
    identity = await lstat(endpoint);
    await chmod(endpoint, 0o600);
  } };
}

/** No runtime startup, no home lock, no commands. Caller owns terminal rendering. */
export async function attachObserver(endpoint: string, output: (line: string) => void, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 16384) { socket.destroy(Error("Observer frame too large")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.type !== "status") throw Error("Invalid observer frame");
          output(JSON.stringify(frame));
        } catch { socket.destroy(Error("Invalid observer frame")); return; }
      }
    });
    socket.on("error", reject);
    socket.on("close", () => { signal.removeEventListener("abort", abort); resolve(); });
  });
}
