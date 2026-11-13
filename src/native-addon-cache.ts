import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";

// Same immutable release checksum already used by the dependency-check CI.
// Never infer trust from a filename, successful download, or source directory.
const version = "0.4.0";
const filename = "matrix-sdk-crypto.linux-x64-gnu.node";
const sha256 = "7078d4dd987128f79afd192c4f621f64adece37e43f2a8756f1d0a9f034de718";
const relative = "node_modules/@matrix-org/matrix-sdk-crypto-nodejs";

/** Optional offline reuse of one EXACT verified release, not a native-test bypass.
 * Other versions/platforms still use the normal downloader and load check. */
export async function restoreVerifiedMatrixAddon(targetCore: string, sourceCores: readonly string[]): Promise<boolean> {
  if (process.platform !== "linux" || process.arch !== "x64" || !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime) return false;
  const target = path.join(targetCore, relative);
  let pkg: { version?: string };
  try { pkg = JSON.parse(await readFile(path.join(target, "package.json"), "utf8")); } catch { return false; }
  if (pkg.version !== version) return false;
  for (const core of sourceCores) {
    try {
      const source = path.join(core, relative);
      if (JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).version !== version) continue;
      const file = path.join(source, filename);
      const size = (await stat(file)).size;
      if (size < 4096 || size > 64 * 1024 * 1024) continue;
      const bytes = await readFile(file);
      if (createHash("sha256").update(bytes).digest("hex") !== sha256) continue;
      // Atomic replacement also repairs a corrupt download in this PRIVATE new
      // release. No active installation, cache source, config or ledger changes.
      await writeFileDurable(path.join(target, filename), bytes);
      return true;
    } catch { /* A missing/corrupt cache is optional; try another exact source. */ }
  }
  return false;
}
