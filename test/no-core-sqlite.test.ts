import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

// Matrix's external crypto SDK owns its storage implementation. It is the only
// permitted external exception, not permission to add a database to Core code.
test("Core source never imports a SQLite implementation", async () => {
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await inspect(file);
      else if (entry.name.endsWith(".ts")) {
        const source = await readFile(file, "utf8");
        assert.doesNotMatch(source, /["'](?:node:sqlite|sqlite3|better-sqlite3|@libsql\/client|sql\.js)["']/, file);
      }
    }
  }
  await inspect("src");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).some(name => /sqlite|libsql|sql\.js/i.test(name)));
});
