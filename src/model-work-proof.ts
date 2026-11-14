import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** A separate scheduling-only key: never a provider credential, task/effect grant or replay consent. */
export class ModelWorkProof {
  private constructor(private readonly key: KeyObject, private readonly id: string) {}
  static async load(file: string | undefined): Promise<ModelWorkProof | undefined> {
    if (!file) return;
    let handle;
    const raw = Buffer.alloc(8193);
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 8192 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) return;
      const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
      if (bytesRead > 8192) return;
      const key = createPrivateKey(raw.subarray(0, bytesRead));
      if (key.asymmetricKeyType !== "ed25519") return;
      const publicDer = createPublicKey(key).export({ type: "spki", format: "der" });
      return new ModelWorkProof(key, createHash("sha256").update(publicDer).digest("hex"));
    } catch { return; }
    finally { raw.fill(0); await handle?.close().catch(() => {}); } // No proof means background, never cloud/fallback or new authority.
  }
  add(headers: Record<string, string | null>): void {
    const nonce = randomUUID(), expires = String(Date.now() + 30_000);
    const message = `hayate-model-work-v1\ninteractive\n${this.id}\n${nonce}\n${expires}`;
    Object.assign(headers, {
      "X-Hayate-Qos-Key": this.id, "X-Hayate-Qos-Nonce": nonce, "X-Hayate-Qos-Expires": expires,
      "X-Hayate-Qos-Signature": sign(null, Buffer.from(message), this.key).toString("base64url"),
    });
  }
}
