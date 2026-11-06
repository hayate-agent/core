// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

/** Build metadata is baked into the image, never read from the agent workspace. */
export function readBuildInfo(): { version: string; revision?: string } {
  try {
    const data = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(data.version) || !/^[a-f0-9]{40}$/.test(data.revision)) throw new Error("Invalid build metadata");
    return { version: data.version, revision: data.revision };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return { version: pkg.version };
  }
}
export const BUILD_INFO = readBuildInfo();
