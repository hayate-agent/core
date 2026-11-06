/**
 * Disclosure policy for approval prompts: they may be posted in shared rooms, so tool
 * arguments are never shown; only an allowlisted program name or a file path.
 */

/** Bounded, allowlisted action summary for approval prompts in potentially shared rooms. */
export function approvalPreview(tool: string, input: unknown): string {
  if (input === undefined) return "(no arguments)";
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "(argument hidden)";
  const args = input as Record<string, unknown>;
  const name = tool.toLowerCase().split(/[.:/]/).at(-1) ?? tool.toLowerCase();
  if ((name === "bash" || name === "shell") && typeof args.command === "string") return shellSummary(args.command);
  if (["read", "write", "edit"].includes(name) && typeof args.path === "string") return `path: ${safePath(args.path)}`;
  const count = Object.keys(args).length;
  return `(arguments hidden; ${count} field${count === 1 ? "" : "s"})`;
}

const SAFE_SHELL_PROGRAMS = new Set([
  "bash", "sh", "git", "npm", "npx", "node", "python", "python3", "make", "docker", "kubectl", "helm", "terraform", "tofu", "ansible", "curl", "wget", "ssh", "scp", "rsync", "rm", "mv", "cp", "mkdir", "chmod", "chown", "systemctl",
]);

function shellSummary(command: string): string {
  const words = command.match(/[^\s"']+|"[^"]*"|'[^']*'/g) ?? [];
  let candidate = "";
  for (const word of words) {
    const plain = word.replace(/^['"]|['"]$/g, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain)) continue;
    candidate = plain.split("/").at(-1) ?? "";
    break;
  }
  const program = SAFE_SHELL_PROGRAMS.has(candidate) ? candidate : "custom command";
  return `shell action: ${program}; arguments hidden`;
}

function safePath(value: string): string {
  return JSON.stringify(value.replace(/[\r\n\t]/g, " ").slice(0, 200));
}
