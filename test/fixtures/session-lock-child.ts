import { SessionLock } from "../../src/session-lock.js";
import { LocalSessions } from "../../src/local-sessions.js";
try {
  const lock = process.argv[3] === "home"
    ? await LocalSessions.open(process.argv[2]!, process.argv[2]!)
    : await SessionLock.acquire(process.argv[2]!);
  if (lock instanceof LocalSessions) { await lock.acquireHome(); await lock.create("crash fixture"); }
  process.send!("acquired");
  process.on("message", async () => { await lock.release(); process.exit(0); });
} catch (error) {
  if (!String(error).includes("already open")) throw error;
  process.send!("busy", () => process.exit(0));
}
