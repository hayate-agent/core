#!/usr/bin/env node
/** Trusted build-owner entrypoint. Prepares reviewed, private source; never pushes,
 * merges, mutates a runtime, or grants itself review authority. Run candidate
 * Docker builds/tests separately without publisher/reader credentials. */
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { updateCommand, softwareUpdatePolicy, type SoftwareComponent } from "./software-updates.js";
import { resolveVariant, variantPolicy, verifyVariantReview, applyVariant, variantPluginLock, hashVariant } from "./software-variants.js";

export async function composeAgentVariant(config: unknown, output: string): Promise<void> {
  const policy = variantPolicy(config);
  // Fail if caller did not reserve a fresh directory; never reuse/clean worktrees.
  await mkdir(output, { mode: 0o700 });
  output = realpathSync(output);
  const checkout = path.join(output, "profile"); await mkdir(checkout);
  const variant = await resolveVariant(policy, checkout, updateCommand);
  const review = await verifyVariantReview(policy, variant);
  const roots = {} as Record<SoftwareComponent, string>;
  for (const c of ["core", "plugins", "webui"] as const) {
    roots[c] = path.join(output, c); await mkdir(roots[c]);
    const base = variant.recipe.bases[c];
    for (const args of [["init", "--quiet"], ["remote", "add", "origin", base.repository],
      ["fetch", "--depth=1", "origin", base.revision], ["checkout", "--detach", "FETCH_HEAD"]])
      await updateCommand("git", ["-c", "core.hooksPath=/dev/null", ...args], roots[c]);
    if ((await updateCommand("git", ["rev-parse", "HEAD"], roots[c])).trim() !== base.revision) throw Error("Variant base identity mismatch");
  }
  await applyVariant(variant, roots, output, updateCommand);
  await variantPluginLock(roots.core, roots.plugins, variant);
  const lock = JSON.parse(await readFile(path.join(roots.core, "plugins.lock.json"), "utf8"));
  // Docker cannot fetch fork-only/patched bytes from the upstream raw URL.
  // Materialize the exact hash-locked plugin inputs explicitly in its context.
  if (lock.revision !== variant.recipe.bases.plugins.revision) throw Error("Variant Plugins base must match Core lock");
  const vendor = path.join(roots.core, "vendor/plugins/src"); await mkdir(vendor, { recursive: true });
  for (const [file, digest] of Object.entries(lock.files)) {
    if (!/^[a-z][a-z0-9-]*\.ts$/.test(file)) throw Error("Invalid plugin lock file");
    const source = path.join(roots.plugins, "src", file), bytes = await readFile(source);
    if (hashVariant(bytes) !== digest) throw Error("Variant plugin bytes do not match lock");
    await copyFile(source, path.join(vendor, file));
  }
  const pkg = JSON.parse(await readFile(path.join(roots.core, "package.json"), "utf8"));
  const info = { version: pkg.version, revision: variant.recipe.bases.core.revision, variant: variant.identity };
  await writeFile(path.join(roots.core, "variant-build-info.json"), JSON.stringify(info) + "\n");
  const docker = await readFile(path.join(roots.core, "Dockerfile"), "utf8");
  if (!docker.includes("RUN npm run build") || !docker.includes("LABEL org.opencontainers.image.version=")) throw Error("Unsupported variant Docker layout");
  const buildInputs = "COPY tsconfig.json plugins.lock.json ./\nCOPY scripts ./scripts\nCOPY src ./src";
  if (!docker.includes(buildInputs)) throw Error("Unsupported variant source/test layout");
  const composed = docker.replace(buildInputs, "COPY . .")
    .replace("RUN npm run build", "RUN apt-get update && apt-get install -y --no-install-recommends git python3 openssl && rm -rf /var/lib/apt/lists/*\nRUN chown -R node:node /src\nUSER node\nENV HOME=/home/node\nRUN npm run typecheck && npm run build && npm test")
    .replace("LABEL org.opencontainers.image.version=", "COPY variant-build-info.json ./build-info.json\nLABEL org.opencontainers.image.version=");
  const ignore = (await readFile(path.join(roots.core, ".dockerignore"), "utf8")).split("\n").filter(line => !["test", "test/"].includes(line.trim())).join("\n");
  await writeFile(path.join(roots.core, "Dockerfile.variant.dockerignore"), ignore);
  const coreDocker = composed + `\nLABEL net.hayate.variant=${JSON.stringify(variant.identity.binding)}\n`;
  await writeFile(path.join(roots.core, "Dockerfile.variant"), coreDocker);
  const webDocker = await readFile(path.join(roots.webui, "Dockerfile"), "utf8");
  if (!webDocker.includes("WORKDIR /app")) throw Error("Unsupported variant WebUI Docker layout");
  await writeFile(path.join(roots.webui, "variant-build-info.json"), JSON.stringify({ revision: variant.recipe.bases.webui.revision, variant: variant.identity }) + "\n");
  const webInputs = "COPY scripts ./scripts\nCOPY dashboard ./dashboard";
  if (!webDocker.includes(webInputs) || !webDocker.includes("RUN npm run build")) throw Error("Unsupported variant WebUI test layout");
  await writeFile(path.join(roots.webui, "Dockerfile.variant"), webDocker.replace(webInputs, "COPY . .").replace("RUN npm run build", "RUN chown -R node:node /build\nUSER node\nENV HOME=/home/node\nRUN npm test && npm run build") +
    `\nCOPY variant-build-info.json /app/variant-build-info.json\nLABEL net.hayate.variant=${JSON.stringify(variant.identity.binding)}\n`);
  let webIgnore = ".git\nnode_modules\ndist\n";
  try { webIgnore = (await readFile(path.join(roots.webui, ".dockerignore"), "utf8")).split("\n").filter(line => !["test", "test/", "server", "server/"].includes(line.trim())).join("\n"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(path.join(roots.webui, "Dockerfile.variant.dockerignore"), webIgnore);
  await writeFile(path.join(output, "variant-receipt.json"), JSON.stringify({ schema: 1, identity: variant.identity, review,
    bases: variant.recipe.bases, dockerfileSha256: hashVariant(coreDocker), pluginsLockSha256: hashVariant(await readFile(path.join(roots.core, "plugins.lock.json"))) }, null, 2) + "\n", { mode: 0o600 });
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const [config, output, ...rest] = process.argv.slice(2);
  if (!config || !output || rest.length) { console.error("Usage: compose-agent-variant <trusted-policy.json> <fresh-output-directory>"); process.exitCode = 2; }
  else composeAgentVariant(JSON.parse(await readFile(config, "utf8")), path.resolve(output))
    .then(() => console.log("Reviewed agent variant composed; no image published or runtime changed"))
    .catch(() => { console.error("Variant composition refused; existing installation untouched"); process.exitCode = 1; });
}
