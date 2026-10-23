const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "30s", "15m", "2h", "1d" (also "1h30m"). Returns ms or undefined. */
export function parseInterval(text: string): number | undefined {
  const s = text.trim().toLowerCase();
  if (!/^(\d+[smhd])+$/.test(s)) return undefined;
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+)([smhd])/g)) total += Number(n) * UNITS[u];
  return total > 0 ? total : undefined;
}

export function formatInterval(ms: number): string {
  for (const u of ["d", "h", "m", "s"] as const) {
    if (ms % UNITS[u] === 0) return `${ms / UNITS[u]}${u}`;
  }
  return `${ms}ms`;
}
