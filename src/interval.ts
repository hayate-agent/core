const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "1500ms", "30s", "15m", "2h", "1d" (also "1h30m"). Units must be unique and descending. Returns ms or undefined. */
export function parseInterval(text: string): number | undefined {
  const s = text.trim().toLowerCase();
  if (!s || !/^(\d+d)?(\d+h)?(\d+m)?(\d+s)?(\d+ms)?$/.test(s)) return undefined;
  let total = 0;
  for (const [, n, u] of s.matchAll(/(\d+)(ms|[smhd])/g)) total += Number(n) * UNITS[u];
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

export function formatInterval(ms: number): string {
  for (const u of ["d", "h", "m", "s"] as const) {
    if (ms % UNITS[u] === 0) return `${ms / UNITS[u]}${u}`;
  }
  return `${ms}ms`;
}
