import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { hashVariant, variantRecipe, type ResolvedVariant, type VariantReview } from "./software-variants.js";

/** Validate retained evidence independently of its on-disk JSON assertions. */
export function retainedVariant(value: ResolvedVariant, review: VariantReview): void {
  const v = value;
  if (!v || typeof v.manifestContent !== "string" || hashVariant(v.manifestContent) !== v.identity.recipeSha256 ||
      JSON.stringify(variantRecipe(JSON.parse(v.manifestContent))) !== JSON.stringify(v.recipe) ||
      !/^[a-f0-9]{40}$/.test(v.identity.revision) || !Array.isArray(v.patches) || v.patches.length !== v.recipe.patches.length) throw Error("Invalid retained variant");
  for (let i = 0; i < v.patches.length; i++) {
    const p = v.patches[i]!, expected = v.recipe.patches[i]!;
    if (typeof p.content !== "string" || hashVariant(p.content) !== expected.sha256 ||
        p.path !== expected.path || p.component !== expected.component || p.sha256 !== expected.sha256) throw Error("Retained variant patch changed");
  }
  const { binding, revision: _sourceRevision, ...identity } = v.identity;
  if (hashVariant(JSON.stringify({ ...identity, bases: v.recipe.bases, patches: v.recipe.patches })) !== binding ||
      review.binding !== binding || review.independent !== true || typeof review.reviewer !== "string" ||
      !review.reviewer.trim() || review.reviewer === v.recipe.profile || typeof review.evidence !== "string" || !review.evidence.trim()) throw Error("Unbound retained variant review");
}

/** Bind the source + built payload, including docs/modules, before publication.
 * Dependencies retain the existing npm lock/native-addon integrity contract.
 * Never traverse .git/node_modules or links outside the prepared release.
 */
export async function variantPayloadDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const canonical = await realpath(root);
  let count = 0;
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      if (name === ".git" || name === "node_modules") continue;
      const file = path.join(dir, name), info = await lstat(file);
      if (++count > 50000) throw Error("Variant payload exceeds bound");
      const relative = path.relative(canonical, file);
      if (info.isSymbolicLink()) {
        const target = await realpath(file);
        if (!target.startsWith(canonical + path.sep)) throw Error("Variant payload link escapes release");
        hash.update(JSON.stringify([relative, "symlink", path.relative(canonical, target)]));
      } else if (info.isDirectory()) await walk(file);
      else if (info.isFile()) hash.update(JSON.stringify([relative, info.mode & 0o777, hashVariant(await readFile(file))]));
      else throw Error("Invalid variant payload file");
    }
  }
  for (const c of ["core", "plugins", "webui"]) await walk(path.join(canonical, c));
  return hash.digest("hex");
}
