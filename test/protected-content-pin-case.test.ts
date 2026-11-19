import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtectedContent } from "../src/protected-content.js";

test("uppercase SHA-256 pins (e.g. PowerShell Get-FileHash) verify and still detect tampering", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-case-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "SOUL.md"), "synthetic");
  const lower = createHash("sha256").update("synthetic").digest("hex");
  for (const sha256 of [lower.toUpperCase(), lower.slice(0, 10).toUpperCase() + lower.slice(10)]) {
    const service = new ProtectedContent(home, { files: [{ path: "SOUL.md", sha256 }] });
    await service.verify();
    assert.equal((await service.inspect())[0].expected, lower);
  }
  await writeFile(path.join(home, "SOUL.md"), "tampered");
  await assert.rejects(new ProtectedContent(home, { files: [{ path: "SOUL.md", sha256: lower.toUpperCase() }] }).verify(), /integrity check failed/);
  for (const sha256 of ["A".repeat(63), "A".repeat(65), "G".repeat(64), "", ` ${lower}`])
    assert.throws(() => new ProtectedContent(home, { files: [{ path: "SOUL.md", sha256 }] }), /Invalid protected content pin/);
  assert.throws(() => new ProtectedContent(home, { files: [{ path: "SOUL.md", sha256: 1 as unknown as string }] }), /Invalid protected content pin/);
});
