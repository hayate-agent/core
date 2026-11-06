/** Keep mode selection independent of PI so command routing is testable without a TTY. */
export function launchMode(argv: string[]): "interactive" | "command" {
  return argv.length === 0 ? "interactive" : "command";
}
