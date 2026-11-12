/** Resolve a human-readable source version without borrowing unrelated release tags.
 * Only whole-project vX.Y.Z tags count (not e.g. overlay-v0.4.2).
 * The nearest tagged commit in the bounded checked-out history is a development
 * base, never an assertion that the installed commit is that published release.
 */
export function sourceVersion(revision: string, tags: string, history: string, packageVersion?: string): string {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error("Invalid source revision");
  const names = new Map<string, { direct?: string; peeled?: string; version: string }>();
  for (const line of tags.split("\n")) {
    const match = /^([a-f0-9]{40})\s+refs\/tags\/(v(\d+\.\d+\.\d+))(\^\{\})?$/.exec(line.trim());
    if (!match) continue;
    const entry = names.get(match[2]!) ?? { version: match[3]! };
    if (match[4]) entry.peeled = match[1]; else entry.direct = match[1];
    names.set(match[2]!, entry);
  }
  const versions = new Map<string, string[]>();
  for (const entry of names.values()) {
    const commit = entry.peeled ?? entry.direct;
    if (commit) versions.set(commit, [...(versions.get(commit) ?? []), entry.version]);
  }
  const commits = [revision, ...history.split(/\s+/).filter(value => /^[a-f0-9]{40}$/.test(value))];
  for (const commit of commits) {
    const candidates = versions.get(commit);
    if (!candidates?.length) continue;
    const version = candidates.sort((a, b) => {
      const x = a.split(".").map(Number), y = b.split(".").map(Number);
      return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
    })[0]!;
    return commit === revision ? version : `${version}+dev.${revision.slice(0, 12)}`;
  }
  const base = packageVersion && /^\d+\.\d+\.\d+$/.test(packageVersion) ? packageVersion : "0.0.0";
  return `${base}+git.${revision.slice(0, 12)}`;
}
