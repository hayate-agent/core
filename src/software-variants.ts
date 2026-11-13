import { createHash } from "node:crypto";
import { readFile, writeFile, realpath, stat, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SoftwareComponent, UpdateCommand } from "./software-updates.js";

const components: SoftwareComponent[] = ["core", "plugins", "webui"];
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
export const hashVariant = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export interface VariantPolicy {
  repository: string;
  branch: string;
  manifest: string;
  /** Installed trusted verifier, never an executable from the candidate repo. */
  review: { runner: string; sha256: string };
}
export interface VariantRecipe {
  schema: 1;
  profile: string;
  bases: Record<SoftwareComponent, { repository: string; revision: string }>;
  patches: { component: SoftwareComponent; path: string; sha256: string }[];
}
export interface VariantIdentity {
  profile: string;
  repository: string;
  revision: string;
  manifest: string;
  recipeSha256: string;
  binding: string;
}
export interface VariantReview {
  binding: string;
  reviewer: string;
  evidence: string;
  independent: true;
}
export interface ResolvedVariant {
  identity: VariantIdentity;
  recipe: VariantRecipe;
  manifestContent: string;
  patches: { component: SoftwareComponent; path: string; sha256: string; content: string }[];
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid variant object");
  return value as Record<string, any>;
}
function keys(value: Record<string, any>, expected: string[]): void {
  if (Object.keys(value).sort().join() !== [...expected].sort().join()) throw Error("Invalid variant fields");
}
export function variantRepository(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) throw Error("Invalid variant repository");
  const u = new URL(value);
  if (!["https:", "ssh:", "file:"].includes(u.protocol) || u.password || u.search || u.hash ||
      u.protocol !== "ssh:" && u.username) throw Error("Invalid variant repository");
  return value;
}
function relative(value: unknown): string {
  if (typeof value !== "string" || value.length > 500 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) ||
      value.split("/").some(p => !p || p === "." || p === ".." || p === ".git")) throw Error("Invalid variant path");
  return value;
}
export function variantPolicy(value: unknown): VariantPolicy {
  const p = object(value); keys(p, ["repository", "branch", "manifest", "review"]);
  const r = object(p.review); keys(r, ["runner", "sha256"]);
  if (typeof p.branch !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(p.branch) || p.branch.includes("..") || p.branch.includes("//") ||
      typeof r.runner !== "string" || !path.isAbsolute(r.runner) || typeof r.sha256 !== "string" || !digest.test(r.sha256)) throw Error("Invalid variant review policy");
  return { repository: variantRepository(p.repository), branch: p.branch, manifest: relative(p.manifest), review: { runner: r.runner, sha256: r.sha256 } };
}
export function variantRecipe(value: unknown): VariantRecipe {
  const r = object(value); keys(r, ["schema", "profile", "bases", "patches"]);
  if (r.schema !== 1 || typeof r.profile !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(r.profile)) throw Error("Invalid variant profile");
  const bases = object(r.bases); keys(bases, components);
  const parsed = {} as VariantRecipe["bases"];
  for (const c of components) {
    const b = object(bases[c]); keys(b, ["repository", "revision"]);
    if (typeof b.revision !== "string" || !sha.test(b.revision)) throw Error("Variant requires immutable bases");
    parsed[c] = { repository: variantRepository(b.repository), revision: b.revision };
  }
  if (!Array.isArray(r.patches) || r.patches.length > 128) throw Error("Invalid variant patches");
  const seen = new Set<string>();
  const patches = r.patches.map((value: unknown) => {
    const p = object(value); keys(p, ["component", "path", "sha256"]);
    if (!components.includes(p.component) || typeof p.sha256 !== "string" || !digest.test(p.sha256)) throw Error("Invalid variant patch");
    const file = relative(p.path);
    if (seen.has(file)) throw Error("Duplicate variant patch"); seen.add(file);
    return { component: p.component as SoftwareComponent, path: file, sha256: p.sha256 as string };
  });
  return { schema: 1, profile: r.profile, bases: parsed, patches };
}
async function boundedFile(root: string, file: string, max: number): Promise<Buffer> {
  const full = path.join(await realpath(root), relative(file));
  // Reject symlinks as well as traversal; metadata/code must be inside this checkout.
  if (await realpath(full) !== full || !(await stat(full)).isFile() || (await stat(full)).size > max) throw Error("Unsafe variant file");
  return readFile(full);
}
export async function resolveVariant(policy: VariantPolicy, checkout: string, command: UpdateCommand): Promise<ResolvedVariant> {
  const git = (args: string[]) => command("git", ["-c", "core.hooksPath=/dev/null", ...args], checkout);
  await git(["init", "--quiet"]);
  await git(["remote", "add", "origin", policy.repository]);
  await git(["fetch", "--depth=1", "origin", `refs/heads/${policy.branch}`]);
  const revision = (await git(["rev-parse", "FETCH_HEAD"])).trim();
  if (!sha.test(revision)) throw Error("Invalid variant source revision");
  await git(["checkout", "--detach", revision]);
  const bytes = await boundedFile(checkout, policy.manifest, 65536);
  const recipe = variantRecipe(JSON.parse(bytes.toString("utf8")));
  const patches: ResolvedVariant["patches"] = [];
  let size = 0;
  for (const patch of recipe.patches) {
    const data = await boundedFile(checkout, patch.path, 2 * 1024 * 1024);
    size += data.length;
    if (size > 8 * 1024 * 1024 || hashVariant(data) !== patch.sha256 || data.includes(0) || !Buffer.from(data.toString("utf8")).equals(data)) throw Error("Variant patch digest/size mismatch");
    patches.push({ ...patch, content: data.toString("utf8") });
  }
  const identity = { profile: recipe.profile, repository: policy.repository, revision, manifest: policy.manifest, recipeSha256: hashVariant(bytes) };
  // Unrelated commits in the assigned config repo do not change reviewed code.
  const { revision: _sourceRevision, ...subject } = identity;
  const binding = hashVariant(JSON.stringify({ ...subject, bases: recipe.bases, patches: recipe.patches }));
  return { identity: { ...identity, binding }, recipe, manifestContent: bytes.toString("utf8"), patches };
}

/** The installed, hash-pinned owner verifier authenticates external review evidence.
 * Candidate JSON/PR text cannot approve itself. This is a trusted-code contract,
 * not a sandbox: the verifier must prove logical-author independence and bind its
 * actual provider evidence to this exact base/patch/source tuple. No server-side
 * required-approval setting is changed or assumed.
 */
export async function verifyVariantReview(policy: VariantPolicy, variant: ResolvedVariant, signal?: AbortSignal): Promise<VariantReview> {
  if (await realpath(policy.review.runner) !== policy.review.runner ||
      hashVariant(await readFile(policy.review.runner)) !== policy.review.sha256) throw Error("Variant review verifier integrity mismatch");
  const response = await new Promise<string>((resolve, reject) => {
    const child = spawn(policy.review.runner, [], { stdio: ["pipe", "pipe", "ignore"], env: {
      PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0",
    } });
    let out = "", settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) { child.kill("SIGTERM"); child.stdin.destroy(); child.stdout.destroy(); child.unref(); reject(error); }
      else resolve(out);
    };
    const abort = () => finish(Error("Variant review unavailable"));
    const timer = setTimeout(abort, 30000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", abort); child.stdin.on("error", abort);
    child.stdout.on("data", data => { out += data; if (out.length > 65536) abort(); });
    child.on("close", code => finish(code === 0 ? undefined : Error("Variant review denied")));
    if (signal?.aborted) abort();
    else child.stdin.end(JSON.stringify({ schema: 1, identity: variant.identity, recipe: variant.recipe }) + "\n");
  });
  const r = object(JSON.parse(response)); keys(r, ["binding", "reviewer", "evidence", "independent"]);
  if (r.binding !== variant.identity.binding || r.independent !== true || typeof r.reviewer !== "string" ||
      !r.reviewer.trim() || r.reviewer.length > 200 || r.reviewer === variant.recipe.profile ||
      typeof r.evidence !== "string" || !r.evidence.trim() || r.evidence.length > 2000) throw Error("Invalid external variant review");
  return r as unknown as VariantReview;
}

/** Apply exact, ordered patches in the disposable checkout, never in the running
 * release. Git rejects traversal/symlink escapes; no three-way merge or fuzz retry.
 */
export async function applyVariant(variant: ResolvedVariant, roots: Record<SoftwareComponent, string>, patchDirectory: string, command: UpdateCommand): Promise<void> {
  for (let i = 0; i < variant.patches.length; i++) {
    const patch = variant.patches[i]!;
    const file = path.join(patchDirectory, `patch-${i}.diff`);
    await writeFile(file, patch.content, { mode: 0o600, flag: "wx" });
    const cwd = roots[patch.component];
    await command("git", ["-c", "core.hooksPath=/dev/null", "apply", "--check", "--index", file], cwd);
    await command("git", ["-c", "core.hooksPath=/dev/null", "apply", "--index", file], cwd);
  }
}

/** A deliberately generated local lock: upstream lock identity remains recorded,
 * while patched plugin bytes are hash-bound to this reviewed private variant.
 * No remote source hash is bypassed or silently described as an upstream build.
 */
export async function variantPluginLock(core: string, plugins: string, variant: ResolvedVariant): Promise<void> {
  if (!variant.patches.some(p => p.component === "plugins")) return;
  const file = path.join(core, "plugins.lock.json");
  const lock = JSON.parse(await readFile(file, "utf8"));
  if (lock.schema !== 1 || lock.revision !== variant.recipe.bases.plugins.revision || !lock.files || typeof lock.files !== "object")
    throw Error("Variant Plugins base must match Core lock");
  const baseLockSha256 = hashVariant(await readFile(file));
  for (const name of Object.keys(lock.files)) {
    if (!/^[a-z][a-z0-9-]*\.ts$/.test(name)) throw Error("Invalid bundled plugin path");
    lock.files[name] = hashVariant(await boundedFile(plugins, "src/" + name, 2 * 1024 * 1024));
  }
  lock.variant = { binding: variant.identity.binding, baseLockSha256 };
  await writeFile(file, JSON.stringify(lock, null, 2) + "\n", { mode: 0o600 });
}
