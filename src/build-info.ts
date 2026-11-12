import { readFileSync } from "node:fs";

/** Build metadata is baked into the image, never read from the agent workspace. */
export function readBuildInfo(): { version: string; revision?: string } {
  try {
    const data = JSON.parse(readFileSync(new URL("../build-info.json", import.meta.url), "utf8"));
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]{0,100})?$/.test(data.version) || !/^[a-f0-9]{40}$/.test(data.revision)) throw new Error("Invalid build metadata");
    {
      try {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        const source = JSON.parse(readFileSync(new URL("../dist/source-build-info.json", import.meta.url), "utf8"));
        if (data.version === pkg.version && source.revision === data.revision && /^\d+\.\d+\.\d+(?:\+(?:dev|git)\.[a-f0-9]{12})?$/.test(source.version))
          return { version: source.version, revision: data.revision };
      } catch { /* Older native owners can bootstrap the new metadata reader. */ }
    }
    return { version: data.version, revision: data.revision };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return { version: pkg.version };
  }
}
export const BUILD_INFO = readBuildInfo();
