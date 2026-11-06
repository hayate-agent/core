import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Infrastructure-owned manifest. Runtime-writable settings deliberately cannot alter it. */
export interface ProtectedContentConfig { files: { path: string; sha256: string }[] }
export class ProtectedContent {
  private readonly files: { path: string; sha256: string }[];
  constructor(home: string, config?: ProtectedContentConfig) {
    if (config && (!Array.isArray(config.files) || config.files.length > 256)) throw Error("Invalid protectedContent.files");
    this.files = (config?.files ?? []).map((file) => {
      if (!file || typeof file.path !== "string" || !file.path.trim() || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error("Invalid protected content pin");
      return { path: path.resolve(home, file.path), sha256: file.sha256 };
    });
    if (new Set(this.files.map((f) => f.path)).size !== this.files.length) throw Error("Duplicate protected content path");
  }
  async inspect(): Promise<{ path: string; expected: string; actual?: string; valid: boolean }[]> {
    return Promise.all(this.files.map(async (file) => {
      try {
        const actual = createHash("sha256").update(await readFile(file.path)).digest("hex");
        return { path: file.path, expected: file.sha256, actual, valid: actual === file.sha256 };
      } catch { return { path: file.path, expected: file.sha256, valid: false }; }
    }));
  }
  async verify(): Promise<void> {
    if ((await this.inspect()).some((file) => !file.valid)) throw Error("Protected content integrity check failed; operator intervention required");
  }

}
