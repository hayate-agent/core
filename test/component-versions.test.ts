import assert from "node:assert/strict";
import { test } from "node:test";
import { readSoftwareVersions, formatSoftwareVersions } from "../src/component-versions.js";
import { sourceVersion } from "../src/source-version.js";

const current = "a".repeat(40), ancestor = "b".repeat(40), unrelated = "c".repeat(40), tagObject = "d".repeat(40);

test("source versions match the exact installed commit, including peeled annotated tags", () => {
  assert.equal(sourceVersion(current, `${current}\trefs/tags/v0.1.253`, ""), "0.1.253");
  assert.equal(sourceVersion(current, `${tagObject}\trefs/tags/v0.1.253\n${current}\trefs/tags/v0.1.253^{}`, ""), "0.1.253");
  assert.equal(sourceVersion(tagObject, `${tagObject}\trefs/tags/v0.1.253\n${current}\trefs/tags/v0.1.253^{}`, "", "0.1.0"), `0.1.0+git.${tagObject.slice(0, 12)}`);
});

test("source versions identify development commits rather than claiming a newer uninstalled release", () => {
  const tags = `${unrelated}\trefs/tags/v99.0.0\n${ancestor}\trefs/tags/v0.1.253`;
  assert.equal(sourceVersion(current, tags, `${current}\n${ancestor}`, "0.1.0"), `0.1.253+dev.${current.slice(0, 12)}`);
  assert.equal(sourceVersion(current, `${unrelated}\trefs/tags/v99.0.0`, current, "0.1.0"), `0.1.0+git.${current.slice(0, 12)}`);
  assert.equal(sourceVersion(current, `${current}\trefs/tags/overlay-v0.4.2`, current, "0.1.0"), `0.1.0+git.${current.slice(0, 12)}`);
  assert.throws(() => sourceVersion("invalid", "", ""));
});

test("component versions come from installed locked files, not the independently downloaded plugin/web heads", () => {
  const paths: string[] = [];
  const info = readSoftwareVersions({ version: "0.1.253", revision: current }, relative => {
    paths.push(relative);
    if (relative === "plugins.lock.json") return { schema: 1, revision: ancestor };
    if (relative === "dist/optional-plugins/webui/provenance.json") return { schema: 1, version: "0.1.7", plugin: { revision: unrelated } };
    if (relative === "dist/source-build-info.json") return { revision: current, webPackage: { version: "0.2.1+dev.cccccccccccc", revision: unrelated } };
    throw Error("must not read updater plans, source download folders or operator configuration");
  }, true);
  const text = formatSoftwareVersions(info);
  assert.match(text, /Core: 0\.1\.253 · aaaaaaaaaaaa/);
  assert.match(text, /Plugins \(Core-Bundle\): 0\.1\.253 · bbbbbbbbbbbb/);
  assert.equal(info.components?.webui, undefined);
  assert.doesNotMatch(text, /mitgeliefert|Gateway|0\.1\.7/);
  assert.match(text, /Web-Dashboard \(Paket installiert; Laufzeit nicht bestätigt\): 0\.2\.1\+dev\.cccccccccccc · cccccccccccc/);
  assert.deepEqual(paths, ["plugins.lock.json", "dist/source-build-info.json"]);
});

test("unavailable or malformed legacy metadata remains explicit without blocking readiness", () => {
  const missing = readSoftwareVersions({ version: "0.1.253" }, () => { throw Error("ENOENT"); });
  assert.match(formatSoftwareVersions(missing), /Plugins: Versionsdaten nicht vorhanden/);
  assert.doesNotMatch(formatSoftwareVersions(missing), /Web/);
  const malformed = readSoftwareVersions({ version: "0.1.253" }, path => path === "plugins.lock.json"
    ? { schema: 1, revision: "fake" }
    : { schema: 1, version: "bad\nInjected", plugin: { revision: current } });
  assert.equal(malformed.components?.plugins, undefined);
  assert.equal(malformed.components?.webui, undefined);
  assert.doesNotMatch(formatSoftwareVersions(malformed), /Web/);
  assert.doesNotMatch(formatSoftwareVersions(malformed), /Injected/);
});
