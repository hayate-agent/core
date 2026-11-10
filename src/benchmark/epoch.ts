import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Benchmark numbers are only comparable when the measured system is the same
 * system. Measuring across a models.json edit, a settings change or a build
 * upgrade produced exactly the kind of table that looks like a result and is
 * not one, so the epoch is part of every stored run.
 */
export interface BenchmarkEpoch {
  revision: string;
  version?: string;
  modelsFingerprint: string;
  settingsFingerprint: string;
}

export interface BenchmarkEpochPaths {
  buildInfoPath?: string;
  modelsPath?: string;
  settingsFile?: string;
  settingsDir?: string;
}

async function digest(pathname: string | undefined, missing: string): Promise<string> {
  if (!pathname) return missing;
  try {
    return createHash("sha256").update(await readFile(pathname)).digest("hex").slice(0, 16);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
    throw error;
  }
}

async function settingsDigest(file: string | undefined, dir: string | undefined): Promise<string> {
  const hash = createHash("sha256");
  let seen = 0;
  if (file) {
    try {
      hash.update("local\0").update(await readFile(file));
      seen++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (dir) {
    let entries: string[] = [];
    try {
      entries = (await readdir(dir)).filter(name => /\.ya?ml$/.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of entries) {
      try {
        hash.update("\0").update(name).update("\0").update(await readFile(path.join(dir, name)));
        seen++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return seen ? hash.digest("hex").slice(0, 16) : "absent";
}

export async function benchmarkEpoch(home: string, paths: BenchmarkEpochPaths = {}): Promise<BenchmarkEpoch> {
  let revision = "unknown";
  let version: string | undefined;
  try {
    const info = JSON.parse(await readFile(paths.buildInfoPath ?? path.join(home, "build-info.json"), "utf8")) as { revision?: unknown; version?: unknown };
    if (typeof info.revision === "string" && info.revision) revision = info.revision;
    if (typeof info.version === "string" && info.version) version = info.version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return {
    revision,
    ...(version ? { version } : {}),
    modelsFingerprint: await digest(paths.modelsPath ?? path.join(home, "models.json"), "absent"),
    settingsFingerprint: await settingsDigest(paths.settingsFile ?? path.join(home, "settings.local.yaml"), paths.settingsDir ?? path.join(home, "settings.d")),
  };
}

/** Field names that differ; empty means two runs may be compared directly. */
export function epochDifferences(a: BenchmarkEpoch, b: BenchmarkEpoch): string[] {
  return (["revision", "version", "modelsFingerprint", "settingsFingerprint"] as const)
    .filter(key => a[key] !== b[key]);
}
